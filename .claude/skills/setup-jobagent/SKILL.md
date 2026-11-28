---
name: setup-jobagent
description: Install and set up JobAgent on this computer when the owner asks in the terminal ("set this up", "install JobAgent", "get me started", "help me set up"). Installs what is missing (uv, Bun, Telegram Desktop), prepares the app, opens Telegram and the setup window for them, and watches until their phone is connected. Terminal use by the owner only.
---

# Set up JobAgent

You are talking to the computer's owner **in this terminal**. If your prompt starts with `JobAgent task:`, this is a headless task: refuse. Setup and pairing happen only on the owner's computer.

Goal: the owner does only the three things that need a human. They create a bot in Telegram, copy its token, and tap **Start**. You do everything else. Keep messages short: one or two lines per step, plain words, no jargon. They may not be technical.

`ROOT` below is this project folder (the one with `scripts/setup.ps1`).

## 1. Say what will happen

In about 3 lines: about 10 minutes; you install what's needed and open Telegram for them; they make a private Telegram bot (1 minute, BotFather walks them through it) and tap Start; then the bot asks them a few setup questions on their phone. Nothing is ever sent to an employer without their approval.

## 2. Look at the computer (read-only)

**Windows**, in PowerShell:
```powershell
$env:Path += ";$HOME\.bun\bin;$HOME\.local\bin"
foreach ($c in "uv","bun","claude") { "{0}: {1}" -f $c, [bool](Get-Command $c -EA 0) }
"telegram app: " + (Test-Path "Registry::HKEY_CLASSES_ROOT\tg")
"bot token saved: " + (Test-Path data\.env)
"running: " + [bool](Get-CimInstance Win32_Process | ? { $_.CommandLine -match "app/src/main.ts" })
"claude logged in: " + (claude auth status | ConvertFrom-Json).loggedIn
```
**macOS/Linux:** `command -v uv bun claude brew`, `ls -d /Applications/Telegram*.app`, `test -f data/.env`, `pgrep -f app/src/main.ts`, `claude auth status`.

`Test-Path data\.env` only checks that the file exists. Never open, print or read `data/.env`.

If JobAgent is already **running**, tell them it's already set up and running ("send /menu to your bot"). Ask if they want to set it up again before going on.

## 3. Install what's missing

Say in one line what you're installing and why, then run it. Windows may show a permission pop-up: tell them to click **Yes**. Don't require winget or any package manager on Windows.

| Missing | Windows (PowerShell) | macOS (Homebrew) | Without a package manager |
|---|---|---|---|
| uv (runs the Python helper) | `powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 \| iex"` | `brew install uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` · https://docs.astral.sh/uv/getting-started/installation/ |
| Bun (runs the app) | `powershell -ExecutionPolicy Bypass -c "irm https://bun.sh/install.ps1 \| iex"` | `brew install oven-sh/bun/bun` | `curl -fsSL https://bun.sh/install \| bash` · https://bun.sh |
| Telegram Desktop (recommended: links then open right on this computer) | they download it from https://desktop.telegram.org | `brew install --cask telegram` | https://desktop.telegram.org (Linux: `flatpak install flathub org.telegram.desktop`) |
| cloudflared (only if they want the dashboard on their phone, step 8) | nothing to do: step 8's script gets it | `brew install cloudflared` | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ |

- **Telegram Desktop is optional.** If they'd rather use only their phone, skip it: setup shows a QR code they can scan instead.
- **Claude not logged in:** they run `claude auth login` (a browser opens), using a Claude **Pro or Max** plan (https://claude.com/pricing). JobAgent runs on their own subscription.
- After a fresh install your shell may not find the new tool. Refresh Path the way `scripts/setup.ps1` does (`Refresh-Path`) instead of asking them to restart.

## 4. Open Telegram and get it signed in

Do this now so they can sign in while step 5 installs.
- Windows: `Start-Process "tg://resolve?domain=BotFather"`. macOS: `open "tg://resolve?domain=BotFather"`.
- If Telegram Desktop is new, it asks them to sign in. The easiest way is from their phone: **Telegram → Settings → Devices → Link Desktop Device**, then scan the code on screen.
- No Telegram account at all? They install Telegram on their phone first (https://telegram.org/apps) and sign up with their phone number.

## 5. Prepare the app (you run these; no input needed)

From `ROOT`, one at a time, one line of progress each:
```
cd app && bun install
uv sync --project agent
uv run --project agent playwright install chromium     # ~150 MB the first time; allow up to 10 minutes
```
This makes the setup window in step 6 fly through its install step. If one fails, fix it here; the error is easier to read in your shell than theirs.

## 6. Open the setup window for them

The setup script must run in its **own window**. It asks for the bot token, which must never pass through this chat. It also ends by starting JobAgent, which keeps running in that window. **Never** run it with the Bash tool or with `!`.

- Windows:
  `Start-Process powershell -WorkingDirectory "<ROOT>" -ArgumentList "-NoExit","-ExecutionPolicy","Bypass","-File","<ROOT>\scripts\setup.ps1"`
- macOS:
  `osascript -e 'tell application "Terminal" to do script "cd <ROOT> && scripts/setup.sh"' -e 'tell application "Terminal" to activate'`
- Linux: ask them to open a terminal in this folder and run `scripts/setup.sh`.

Then tell them what to do in it (short):
1. The first checks finish by themselves.
2. **Telegram opens BotFather.** Tap **Start**, send `/newbot`, type any name, then a username ending in `bot` (like `maria_jobs_bot`).
3. BotFather answers with a token like `123456789:AAH…`. **Click it** (that copies it), switch back to the setup window and press **Enter**.
   **Don't paste the token here.** It belongs only in that window.
4. A **QR code** appears. With Telegram Desktop, the bot opens by itself: tap **Start**. Otherwise, scan the QR with the phone camera and tap **Start**.
5. That window is now JobAgent. **Keep it open** (minimizing is fine); closing it turns JobAgent off.

## 7. Watch for the connection

Don't make them tell you when they're done. Start this in the background (Bash, `run_in_background: true`, from `ROOT`):
```bash
for i in $(seq 1 240); do grep -Eq '"paired_user_id": *[0-9]' data/settings.json 2>/dev/null && { echo PAIRED; exit 0; }; sleep 5; done; echo TIMEOUT
```
Reading `data/settings.json` is fine. Never edit it.

- **PAIRED:** check the last lines of `data/logs/app.log` for `polling as @…` and any error. Tell them they're connected. The bot now walks them through a 3-minute setup on their phone: their resume (send a PDF or Word file), the roles, location and pay they want, work eligibility, and a few optional questions. Practice mode is on, so nothing is submitted until they turn it off in ⚙️ Settings.
- **TIMEOUT** (20 minutes): ask where they got stuck, and use the table below.

## 8. Show them the dashboard (optional)

Once they're connected, tell them in two lines that JobAgent also has a dashboard. It shows their whole pipeline on one screen with Approve and Skip, and it opens from Telegram: Home → 🖥 Dashboard gives a private link to open in the browser on this computer. Find the port in `data/logs/app.log` (the last `dashboard on http://127.0.0.1:<port>` line; it's 4777 unless that was taken).

Then ask whether they'd also like it on their phone. If they say no, you're done.

If they say yes:
1. **Windows:** open the phone script in its own window (never inside this session, because it would stop when this session ends):
   `Start-Process powershell -WorkingDirectory "<ROOT>" -ArgumentList "-ExecutionPolicy","Bypass","-File","<ROOT>\scripts\phone.ps1"`
   It gets cloudflared, starts the tunnel and gives JobAgent the address. When the window says their phone can reach the dashboard, they keep it open.
2. **macOS/Linux:** install cloudflared (table in step 3), have them run `cloudflared tunnel --url http://127.0.0.1:<port>` in a **new** terminal window and keep it open, then send the `https://….trycloudflare.com` address to JobAgent: Home → 🖥 Dashboard → 📱 Set up phone access.
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
| "JobAgent is already running" | Only one copy can use the bot. Close the other JobAgent window and do step 6 again. |
| "Another program is using this Telegram bot" | Something else is polling the same bot, often an older JobAgent (v1, or one started by another Claude session). Find it (`bun`/`node` processes) and ask them before stopping it. |
| The pairing link expired (15 minutes) | Run setup again (step 6). It makes a fresh link and skips everything already done. |
| The bot does not answer | The JobAgent window must be open and the computer awake. Check `data/logs/app.log`. |
| The phone dashboard says "Open the dashboard from your JobAgent chat" | It must be opened with the 📱 Open dashboard button, not a browser. Check that the tunnel window is still open and that the address they sent is the current one. |
| "That link is old" on the computer | They should open the newest link from Home → 🖥 Dashboard. |
| A different Telegram account should own it | They run `uv run --project agent jobagent pair --reset` themselves in their own terminal, then setup again. |
| "docx->pdf converter (optional)" warning | Only matters for Word resumes. Install Microsoft Word or LibreOffice (https://www.libreoffice.org/download/), or upload a PDF resume. |

## Never

- Run `jobagent pair`, `credentials`, `login`, `handoff` or `submit` yourself, or `fill` without `--dry-run`.
- Read, print or ask for the bot token or anything in `data/.env`; edit `data/settings.json` or any `approval.json`.
- Read or print `data/dashboard.json` (it holds the dashboard's secret), or set the phone address yourself. Only `scripts\phone.ps1` in its own window, or the owner in Telegram, sets it.
- Run the setup, start or phone scripts inside this session.
- Turn practice mode off, or tell them how to skip the approval step.
