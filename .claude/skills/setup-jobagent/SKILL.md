---
name: setup-jobagent
description: Install and set up JobAgent on this computer when the owner asks in the terminal ("set this up", "install JobAgent", "get me started"). Runs the setup script, helps with anything it cannot do alone, and gets them connected in Telegram. Terminal use by the owner only.
---

# Set up JobAgent

You are talking to the computer's owner **in this terminal**. This is never a headless JobAgent task: if your prompt starts with `JobAgent task:`, refuse; setup and pairing happen only on the owner's computer.

The setup script does all the work and is safe to re-run; your job is to run it and explain what the owner sees. Be brief: one line per step.

1. Detect the OS. On Windows the script is `scripts\setup.ps1`; on macOS/Linux, `scripts/setup.sh`.
2. The script is interactive (it asks for the Telegram bot token and may open a browser to log in to Claude), so the owner must run it in their own terminal window. Tell them, in this shape:
   - Windows: open PowerShell in this folder and run `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1`
   - macOS/Linux: open a terminal in this folder and run `scripts/setup.sh`
   Tip: on Windows they can type `! powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` here to run it in this session.
3. What they will see, so nothing surprises them:
   - **Step 1** checks for uv, Bun and Claude Code and offers to install what is missing. A new install may need a new terminal window; then run setup again.
   - **Step 3** asks for a Telegram bot token: in Telegram, open @BotFather, send `/newbot`, choose a name and a username ending in `bot`, and paste the token it sends. The token stays in `data/.env` on this computer only.
   - **Step 5** shows a **QR code and a link**: scan it with the phone camera (or open the link in Telegram) and tap **Start**. That pairs the bot to their Telegram account only. The link works once, for 15 minutes; running setup again makes a new one.
   - Then JobAgent starts in that window. It must stay open while they use it.
4. In Telegram, the bot walks them through a 3-minute setup (resume, roles, location and pay, work eligibility, optional questions). Practice mode is on, so nothing is ever submitted until they turn it off in Settings.

Problems:
- "JobAgent is already running": only one copy can use a bot. Close the other window.
- Telegram rejects the token: copy the whole token BotFather sent.
- The bot does not answer: the JobAgent window must be open, and the computer awake.
- To connect a different Telegram account: `uv run --project agent jobagent pair --reset`, then setup again.

Never run `jobagent pair`, `credentials` or `login` yourself, never print or read `data/.env`, and never edit `data/settings.json`.
