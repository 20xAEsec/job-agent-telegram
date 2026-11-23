<p align="center"><img src="assets/banner.svg" alt="JobAgent: search for jobs, tailor your resume and apply from a Telegram chat" width="100%"></p>

# JobAgent

**Your own job-application assistant, controlled from Telegram.** It finds jobs that fit you, tailors your resume for each one, fills in the application, and shows you everything before anything is sent.

- 🔒 Runs on **your computer**, with **your own Claude subscription**. Nothing is hosted; your data stays in the `data` folder.
- ✋ **Nothing is sent without you.** Practice mode is on until you turn it off, and every application waits for your Approve.
- 👀 **You always know what it is doing.** Each job gets a live card in the chat that shows the step it is on, in plain words.

---

## What you need

- A computer that stays on while JobAgent works (Windows, macOS or Linux)
- A **Claude Pro or Max** subscription
- **Telegram** on your phone
- About 10 minutes

Everything else (Claude Code, uv, Bun and the form-filling browser) the setup installs for you.

## Set it up

1. **Download JobAgent.** `git clone https://github.com/20xAEsec/job-agent-telegram.git` (or on GitHub click **Code → Download ZIP** and unzip it).
2. **Run the setup** in that folder:
   - **Windows:** right-click `scripts\setup.ps1` → *Run with PowerShell*, or in a terminal:
     `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1`
   - **Mac / Linux:** `scripts/setup.sh`
3. **Follow the five steps it shows you.** It checks your computer, installs what is missing, has you log in to Claude, and helps you create your Telegram bot with @BotFather (one minute; it tells you exactly what to tap).
4. **Scan the QR code** it shows with your phone camera (or open the link), and tap **Start** in Telegram. That connects the bot to you, and only you.
5. **Answer the setup questions in Telegram.** Send your resume, pick the roles you want, location and pay, and a few eligibility questions. About 3 minutes; every answer can be changed later.

Prefer to be guided? Open a terminal in the folder, run `claude`, and say **"set this up"**.

## Start it (next time)

- **Windows:** `scripts\start.ps1`
- **Mac / Linux:** `scripts/start.sh`

Keep that window open (minimizing is fine). Closing it turns JobAgent off. 
Add `-Practice` (Windows) or `--practice` (Mac/Linux) to lock practice mode on.

## Using it

| You want to… | Do this |
|---|---|
| Apply to a job you found | Send the link in the chat. A live card shows each step: reading, scoring, tailoring, filling in, review. |
| Let it find jobs | Home → **🔭 Turn on Auto-search**. It checks companies on a schedule and can find new ones hiring for your titles. |
| See what needs you | Home → **📥 Needs you**: reviews to approve, questions only you can answer, and stuck jobs. |
| Approve an application | On the review card: **✅ Approve**, **✏️ Change something** (just say what), **⏭ Skip**, or **🚫 Never this company**. |
| Change what it looks for | **⚙️ Settings**. Every setting explains what it does. You can also just tell it: *"raise my minimum salary to 120k"*. |
| Fix a saved answer | **👤 Profile → 💾 Saved answers**. Private ones are hidden behind a tap. |
| Track how it's going | **📋 Jobs**: mark Interview, Offer, Rejected or No reply, or export everything to a spreadsheet. |
| Pause or stop | **⏸ Pause** on Home finishes the current step, then waits. **✋ Stop** on a card stops that job. `/stop` stops everything. |

**Practice mode** (on by default): JobAgent does every step except pressing Submit, so you can see exactly what it would send.  
Turn it off in **Settings → Practice mode** when you're ready; you still approve each application.

**Auto-apply** (off by default, Settings → How I apply): only very strong matches are sent on their own, after a countdown with a Cancel button.  
Unusual forms and private questions always come to you.

### What works today

- Filling in **Greenhouse** application forms (used by thousands of companies). Links to other sites are still read and scored, and you get the link to apply yourself.
- Auto-search over Greenhouse job boards.
- Resume tailoring for **PDF** and **Word (.docx)** resumes. For .docx you need Microsoft Word or LibreOffice installed (setup tells you).

## Privacy and safety

- Your profile, saved answers, resume and job history live in `data/` on your computer. Delete that folder to erase everything.
- The thinking runs on your own Claude account. Telegram bot chats are not end-to-end encrypted, so private answers (salary, work authorization, diversity questions) are hidden behind a tap and never guessed.
- Job postings are treated as untrusted text and are read by a separate, sandboxed reader, so a posting can never give JobAgent instructions.
- Only the app can submit, only after you approve, and the approval is tied to the exact answers and files you saw. If anything changes, it asks again.
- It never solves CAPTCHAs or creates accounts. Jobs that need that come to you.

## Troubleshooting

- **The bot doesn't answer:** is the JobAgent window still open, and is the computer awake?
- **"Usage limit reached":** that's your Claude plan's limit. JobAgent waits and continues by itself; the card says when.
- **"Claude needs you on your computer":** open a terminal, run `claude`, and log in again.
- **A job says "Needs you":** it hit a login, a CAPTCHA or an odd page. Open it from **📋 Jobs** and tap **Try again**, or apply by hand.
- **"JobAgent is already running":** only one copy can use your bot. Close the other window.
- **Connect a different Telegram account:** run `uv run --project agent jobagent pair --reset`, then the setup again.

Logs are in `data/logs/app.log` (no personal data is logged).

---

## For developers

```
app/      Bun + TypeScript: the Telegram bot, screens, live cards, setup wizard, review gate, and the Claude task runner
agent/    Python (uv): job store, Greenhouse adapter, resume tailoring, form filling (Playwright), discovery, the submit choke point
.claude/  Claude's skills, the sandboxed job-analyst subagent, and the permission rules for headless tasks
```

- The app runs each piece of work as a headless `claude -p` task (`app/src/agent.ts`) with `--output-format stream-json`. Every tool call streams back and becomes the plain-words line on the live card (`app/src/activity.ts`). Usage-limit events re-queue the task until the limit resets. The queue lives in `data/tasks.json` and survives restarts.
- Claude reaches the app through a small MCP shim (`app/src/mcp.ts`), which forwards tool calls to a localhost-only endpoint that has a per-run secret (`app/src/bridge.ts`). Tool rules are enforced in code; for example, settings can only change from chat, and practice mode can never be turned off by Claude.
- Permissions: tasks run with `--setting-sources project --settings .claude/settings.json --permission-prompts none`. Anything outside the allow list is denied automatically, so nobody is ever asked to approve a permission.
- Only `app/src/review.ts` writes `approval.json` and runs `jobagent submit`. `jobagent submit` refuses unless the approval hash matches the plan and files on disk.

Tests:

```
cd app && bun test                 # app: screens, forms, task runner, bridge, review gate, setup wizard
uv run --project agent pytest      # Python: store, Greenhouse, tailoring, safety, discovery
```
