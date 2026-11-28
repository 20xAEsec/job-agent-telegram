<p align="center"><img src="assets/banner.svg" alt="JobAgent: search for jobs, tailor your resume and apply from a Telegram chat" width="100%"></p>

# JobAgent

**Your own job-application assistant, run from a Telegram chat.** It finds jobs that fit you, adjusts your resume for each one, fills in the application, and shows it to you before anything is sent.

- 🔒 **It runs on your computer**, using your own Claude subscription. There is no JobAgent website or account, and your files are kept in the `data` folder.
- ✋ **You stay in control.** It starts in practice mode, where nothing is sent. After that, each application waits for your approval, unless you turn on [Autopilot](#autopilot).
- 👀 **You can see what it's doing.** Each job gets a card in the chat that shows the current step in plain words.

**Contents:** [What you need](#what-you-need) · [Set it up](#set-it-up) · [Start and stop](#start-and-stop) · [Your first application](#your-first-application) · [Everyday use](#everyday-use) · [Finding jobs automatically](#finding-jobs-automatically) · [Autopilot](#autopilot) · [Applying and resumes](#applying-and-resumes) · [Dashboard](#dashboard) · [Updating](#updating) · [Privacy and safety](#privacy-and-safety) · [Troubleshooting](#troubleshooting)

---

## What you need

- A **Windows, Mac or Linux** computer that stays on and awake while JobAgent works
- A **Claude Pro or Max** subscription
- **Telegram** on your phone
- Your **resume** as a PDF or Word (.docx) file
- About **10 minutes**

You don't need to install anything else first. The setup offers to install the other tools it needs (Claude Code, uv, Bun and a separate web browser for filling in forms).

## Set it up

### 1. Download JobAgent

Pick one:

- **Easiest:** on [the GitHub page](https://github.com/20xAEsec/job-agent-telegram), click **Code → Download ZIP**, then unzip it.
- **If you have [Git](https://git-scm.com/downloads)** (needed for one-click updates later): `git clone https://github.com/20xAEsec/job-agent-telegram.git`

### 2. Run the setup

Open a terminal (a window where you type commands) **in the JobAgent folder**:

- **Windows:** open the folder, right-click an empty spot and choose **Open in Terminal**.
- **Mac:** open the Terminal app, type `cd ` (with a space), drag the folder onto the window and press Enter.

Then paste the command for your computer and press Enter:

| Computer | Command |
|---|---|
| Windows | `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` |
| Mac or Linux | `bash scripts/setup.sh` |

It's safe to run the setup again at any time. It skips whatever is already done.

### 3. Follow the five steps on screen

The setup checks your computer, installs what's missing, asks you to log in to Claude, and walks you through making your own **Telegram bot**. You make the bot by messaging **@BotFather**, Telegram's official bot for this. It gives you a "token" (a long code, like a password for your bot) that you paste into the setup. Don't share it.

### 4. Connect your phone

Scan the QR code with your phone's camera (or open the link), then tap **Start** in Telegram. This connects the bot to you, and only you. The link works once and expires after 15 minutes. Run the setup again to get a new one.

### 5. Answer a few questions in Telegram

Send your resume, then choose job titles, location and pay, and answer some eligibility questions. It takes about 3 minutes, and you can change any answer later.

> **Already use Claude Code?** Open a terminal in the folder, run `claude`, and say **"set this up"**. Claude does the installing and tells you when your phone is connected.

## Start and stop

JobAgent only works while it's running on your computer. Setup starts it for you. Next time:

| Computer | To start it |
|---|---|
| Windows | `powershell -ExecutionPolicy Bypass -File scripts\start.ps1` |
| Mac or Linux | `bash scripts/start.sh` |

Keep that window open (minimizing is fine). Closing it turns JobAgent off.

**Windows only: run it in the background.** It then starts when you log in, has no window, and restarts if it crashes. The setup offers this at the end. To manage it later:

```
powershell -ExecutionPolicy Bypass -File scripts\background.ps1
```

Add `-Status` to check on it, or `-Remove` to turn it off.

To force practice mode on for one session, add `-Practice` (Windows) or `--practice` (Mac and Linux) to the start command.

## Your first application

1. Find a job online and **send its link** to your bot.
2. Watch the card as JobAgent reads the posting, scores how well you match, tailors your resume and fills in the form.
3. If it needs something only you know, tap **❓ Open Questions** and answer there.
4. Look over the **review card**: every answer, what changed on your resume, the cover letter, and pictures of the filled-in form.
5. Tap **✅ Approve**.

**🧪 Practice mode is on at the start.** JobAgent does everything except press Submit, so you can see exactly what it would send. When you're ready, turn it off in **⚙️ Settings → Practice mode**. To send a job you practiced on, open it and tap **🚀 Apply for real**. It's prepared again and waits for a new approval.

## Everyday use

Send `/menu` to open the Home screen.

### Reviewing applications

| Button on the review card | What it does |
|---|---|
| **✅ Approve** | Sends the application (or finishes the practice run). |
| **✏️ Edit an answer** | Changes one answer right away. |
| **📄 Use my original** | Uses your own resume instead of the tailored one. |
| **💬 Ask for a change** | Say what you want changed, in your own words. |
| **✋ I have a missing skill** | Adds a skill you really have and redoes the resume. |
| **⏭ Skip** | Drops this job. You can say why, so it chooses better next time. |
| **🚫 Never this company** | Never applies to that company again. |

### Other things you can do

| You want to… | Do this |
|---|---|
| See what needs your attention | Home → **📥 Needs you**: reviews, questions and stuck jobs. |
| Add something your resume leaves out | Send `remember:` followed by what you did and where, for example *"remember: at Acme I moved our reporting to a new tool and cut build time by half"*. It's saved in your **🧠 Fact bank** (under 👤 Profile, up to 60 entries) and used in later applications. The **🔁 Use on waiting reviews** button (it shows how many) applies it to ones you haven't approved yet. |
| Change what it looks for | **⚙️ Settings**, or just tell it: *"raise my minimum salary to 120k"*. |
| Fix a saved answer | **👤 Profile → 💾 Saved answers**. Private ones are hidden until you tap. |
| Track your applications | **📋 Jobs**: mark Interview, Offer, Rejected or No reply, or export a spreadsheet. **📊 Insights** shows what's getting replies, and a summary arrives on Monday mornings. |
| Remove a job (duplicate or wrong link) | Open it and tap **🗑 Delete**. |
| Prepare for an interview | Mark the job **🗣 Interview**, then tap **🎤 Interview prep** for a company overview, likely questions, example stories from your experience and questions to ask. |
| Follow up | After a week of silence it asks how things went and can **✍️ draft a follow-up email**. You send it yourself. |
| Quiet the notifications | **⚙️ Settings → 🔔 Notifications**. Messages arrive silently from 11 pm to 7 am by default, and auto-search waits until morning. Type *"snooze"* for an hour of silence. |
| Ask a quick question | Type *"status"*, *"what's waiting?"* or *"show my jobs"*. |
| Pause or stop | **⏸ Pause** on Home finishes the current step, then waits. **✋ Stop** on a card stops that job. `/stop` stops everything. |

If you approve or skip at least 15 jobs, Home may suggest a better minimum match score, and later scoring takes your choices into account.

## Finding jobs automatically

Instead of sending links, tap **🔭 Turn on Auto-search** on Home. It searches on a schedule (every 6 hours unless you change it) and sends you one summary of what it prepared, best match first. Tap **🔔 Review all** to go through them.

**Where it looks** (change in ⚙️ Settings → Auto-search → Where I look):

| On from the start | You can also turn on |
|---|---|
| Companies you watch | Glassdoor |
| A built-in list of a few hundred large tech, AI and security employers | ZipRecruiter |
| LinkedIn and Indeed | ClearanceJobs |
| Dice, Himalayas and Jobicy | Remote OK, We Work Remotely, Working Nomads |
| | Hacker News "Who is hiring" |

**Settings worth checking:**

- **Country** (under What I look for): so job sites search the right place.
- **Posted within** (under What I look for): 2 weeks by default. For only the newest jobs, set it to 1 hour and set **How often** to every hour.
- **Related titles**: other names for your kind of work. These need a higher match score.
- **Jobs with other titles**: lets in a few jobs a day with different titles that ask for your skills.
- **Find new companies**: once a day, searches the web for employers hiring for your titles. Only your job titles and locations are used in the search.

**Jobs it skips:** wrong country, pay below your minimum, wrong level or job type, and similar. Home → **🔎 Filtered out** lists each one with the reason. Tap **👀 Look at it anyway** if it got one wrong. Links you send yourself are never filtered and go first.

Job sites sometimes limit frequent searching, so a site may go quiet for a few hours.

## Autopilot

Autopilot is **off until you choose it** (at the end of setup, or in **⚙️ Settings → How I apply**). It searches by itself, prepares good matches, and sends very strong ones after a countdown that has a **Cancel** button. You get one quiet summary a day. Choose **👀 I review each one** to go back to approving everything.

Its safety limits:

- Practice mode still applies. Nothing is really sent until you turn it off.
- At most 10 applications a day on its own (you can change this).
- The first 3 real applications on each type of application form always wait for you.
- If two sends in a row fail, it stops auto-applying until you tap **▶ Resume**.
- Unusual forms, private questions and suspicious postings always come to you.

**Cleanup (with or without Autopilot):** found jobs you don't respond to within a week are closed (**Apply anyway** brings one back). After 30 days, saved files for skipped, closed, failed and practice jobs are deleted. Jobs you applied to are kept.

## Applying and resumes

### Which forms it can fill in

JobAgent fills in application forms built with **Greenhouse, Lever, Ashby, Breezy, Recruitee and Rippling**. Thousands of companies use these. If you send a LinkedIn, Indeed or company website link, it first tries to find the same job on one of those forms.

For other jobs, a good match gets an **application kit**: your tailored resume, a cover letter if needed, draft answers you can tap to copy, and the link. Apply on the site yourself, then tap **✅ I applied** so it's tracked.

### "Are you a human?" checks

JobAgent never solves these (CAPTCHAs) or creates accounts. On the job's card, tap **🖥 Open filled form**. A browser window opens **on the computer running JobAgent** with your application typed in. Complete the check, look over the answers and press Submit. **This really sends it, even in practice mode.**

### Job site logins

Most LinkedIn and Indeed postings can be read without logging in. If one can't, the job's card shows **🔑 Log in**, which opens JobAgent's own browser window on your computer. It doesn't use the logins saved in your everyday browser.

You can choose **Save password** to store it in your computer's password manager (Windows Credential Manager or Mac Keychain). It is never sent through Telegram. Manage this under **⚙️ Settings → 🔑 Job site logins**. You still apply on those sites yourself.

### Resume tailoring

Choose a style in **⚙️ Settings → How I apply → Resume tailoring**:

- **Rebuild for ATS** (default): makes a clean, one-column resume for each job that is easy for hiring software (an "applicant tracking system") to read. It uses the posting's wording where it's true of you.
- **Moderate** or **Light touch**: keeps your layout and rewords a few lines. If your resume is a Word file, you need Microsoft Word or LibreOffice installed.

It's designed not to invent experience: new wording is checked against your own resumes and facts, and skills it can't back up are shown to you as gaps. Still, read each review before approving. If you have several versions of your resume, add them under **👤 Profile → 📚 Resume versions** and it picks the best lines for each job.

## Dashboard

The dashboard is a bigger view of JobAgent for when you're at your desk: review applications, manage jobs, answer questions, edit your profile and settings, and see insights. Approving there works the same as in Telegram, and practice mode still applies.

### On your computer

In Telegram, tap Home → **🖥 Dashboard**. Open the link it gives you (it starts with `http://127.0.0.1`) on the computer running JobAgent. **Treat the link like a password.**

### On your phone (optional)

This is off by default. Your phone needs a "tunnel", a secure public address that points to your computer. JobAgent uses a free one from Cloudflare. JobAgent must be running.

**Windows:**

1. In a new terminal in the JobAgent folder, run `powershell -ExecutionPolicy Bypass -File scripts\phone.ps1` and keep the window open. It downloads what it needs the first time.
2. In Telegram, tap Home → 🖥 Dashboard → **📱 Open dashboard**.

**Mac or Linux:**

1. Install Cloudflare Tunnel ([download page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/); on a Mac with Homebrew: `brew install cloudflared`).
2. Run `cloudflared tunnel --url http://127.0.0.1:4777` and keep it open.
3. In Telegram, tap Home → 🖥 Dashboard → **📱 Set up phone access** and send the `https://….trycloudflare.com` address it printed.
4. Tap **📱 Open dashboard**.

**Good to know:**

- Only your own Telegram account can sign in on the phone. Private answers are never shown in the dashboard.
- Cloudflare can see the traffic passing through, such as your job titles, scores and resume changes.
- The free address changes each time the tunnel restarts. The Windows script updates it for you; on Mac or Linux, send the new one. For a permanent address, look into a named Cloudflare Tunnel or Tailscale Funnel.
- To turn phone access off, tap **🚫 Turn off phone access** or close the tunnel window.
- [How the dashboard is protected](docs/dashboard.md) (technical).

<details>
<summary>Advanced dashboard options</summary>

Start JobAgent with the environment variable `JOBAGENT_DASHBOARD=0` to turn the dashboard off, or set `JOBAGENT_DASH_PORT` to change its port. If port 4777 is taken, JobAgent picks another and shows it in the link.

</details>

## Updating

- **If you used `git clone`:** when there's a new version, **🩺 Health** shows **⬆️ Update and restart**.
- **If you downloaded the ZIP:** there's no update button. To get it, use `git clone` instead.

### Upgrading from version 2

Your jobs, resumes, saved answers, settings and Telegram connection come with you. The old folder is not changed.

1. **Stop the old version:** close its window, or run `scripts\background.ps1 -Remove` in its folder. Never run both at once.
2. **Download the new version** into a new folder next to the old one.
3. **Copy your data over before running setup.** In a terminal in the new folder, run this, replacing `job-agent-v2` with your old folder's name:
   - Windows: `uv run --project agent jobagent migrate --from ..\job-agent-v2\data`
   - Mac or Linux: `uv run --project agent jobagent migrate --from ../job-agent-v2/data`
4. **Run the setup** as described [above](#2-run-the-setup).

Then check **⚙️ Settings → What I look for → Country**, and tap **Check now** under **🔑 Job site logins**.

## Privacy and safety

- Your profile, resume, saved answers and job history are stored in the `data` folder on your computer. Stop JobAgent and delete that folder to erase them. Passwords you saved are in your computer's password manager.
- Some information does leave your computer: Claude processes your resume and job postings under your own account, messages go through Telegram, and applications you approve go to the employer.
- Telegram bot chats are **not end-to-end encrypted**. Private answers (salary, work authorization, diversity questions) are hidden until you tap, and are never guessed.
- Applications are sent only after you approve them, or under the Autopilot rules if you turned it on. If an application changes after you approve it, it asks again.
- A job posting could contain hidden instructions meant to trick an AI. JobAgent treats postings as untrusted text: Claude can't take any action while reading them, and the app checks its answers.
- The dashboard can only be reached from your computer unless you set up phone access.

## Troubleshooting

`/health` checks your computer and suggests fixes.

| Problem | What to do |
|---|---|
| The bot doesn't answer | Check that JobAgent is running and your computer is awake. |
| "Usage limit reached" | You've hit your Claude plan's limit. JobAgent waits and continues by itself. |
| "Claude needs you on your computer" | Open a terminal, run `claude` and log in again. |
| A job says "Needs you" | It hit a login, a human check or an unusual page. Open it in **📋 Jobs** and tap **Try again**, or apply yourself. |
| "JobAgent is already running" | Only one copy can use your bot. Close the other one. |
| Phone dashboard says to open it from your chat | Use the **📱 Open dashboard** button rather than a browser. Check that the tunnel window is still open; on Windows, run `scripts\phone.ps1` again. |
| Connect a different Telegram account | Run `uv run --project agent jobagent pair --reset`, then run the setup again. |

If you need to share logs, they're in `data/logs`. They record what happened, not your answers or the text of job postings. Look through them before sharing.

### Let Claude fix a bug (optional)

When something fails, tap **🔧 Let Claude look into this** (or send `/fix`). Your Claude reads the logs, tries a fix on a separate copy of the code, tests it and shows it to you. **Nothing is shared unless you tap ✅ Open the pull request**, which proposes the fix to this project from your GitHub account. Your copy changes only after the fix is accepted and you update.

This needs a `git clone` install and the [GitHub CLI](https://cli.github.com), logged in with `gh auth login`. Personal details are removed from the logs Claude reads, and a fix can't change the safety or approval rules.

---

## For developers

```
app/      Bun + TypeScript: the Telegram bot, screens, live cards, setup wizard, review gate, the job pipeline and the Claude task runner
agent/    Python (uv): job store, Greenhouse / Lever / Ashby / Breezy / Recruitee / Rippling adapters, resume tailoring, form filling (Playwright), discovery, the submit choke point
prompts/  the tool-less Claude calls the job pipeline makes (one judgment each, with a JSON schema; code checks every answer)
.claude/  Claude's skills for chat, auto-search, interview prep and repairs, and the permission rules for those headless tasks
```

- Job, resume, change-request and follow-up work runs in code (`app/src/pipeline.ts`): Python does each step, and Claude is asked only for single judgments, each a `claude -p` call with no tools whose answer `jobagent llm accept` checks before anything is written (`app/src/llm.ts`, `prompts/`).
- Chat, finding new companies, interview prep and repairs are headless `claude -p` sessions with tools (`app/src/agent.ts`). Their tool calls stream back and become the plain-words line on the live card (`app/src/activity.ts`). Usage-limit events re-queue any task until the limit resets. The queue lives in `data/tasks.json` and survives restarts.
- Claude reaches the app through a small MCP shim (`app/src/mcp.ts`), which forwards tool calls to a localhost-only endpoint that has a per-run secret (`app/src/bridge.ts`). Tool rules are enforced in code; for example, settings can only change from chat, and practice mode can never be turned off by Claude.
- Permissions: those sessions run with `--setting-sources project --settings .claude/settings.json --permission-prompts none`. Anything outside the allow list is denied automatically, so nobody is ever asked to approve a permission.
- Only `app/src/review.ts` writes `approval.json` and runs `jobagent submit`. `jobagent submit` refuses unless the approval hash matches the plan and files on disk.
- Auto-search sources: watched boards and the shipped employer list (`agent/jobagent/discover/catalog.json`), job sites via [python-jobspy](https://github.com/speedyapply/JobSpy) (`discover/sites.py`), and job feeds (`discover/feeds.py`).
- The repair task refuses changes to the safety rules, the approve-and-submit gate, pairing, setup scripts and dependency lists, is limited to 10 files and 400 lines, and offers only fixes that pass the tests.
- CLI for logins: `uv run --project agent jobagent login linkedin|indeed|status` and `jobagent credentials set|delete linkedin|indeed`.

Tests:

```
cd app && bun test                 # app: screens, forms, task runner, bridge, review gate, setup wizard
uv run --project agent pytest      # Python: store, ATS adapters, tailoring, safety, discovery
uv run --project agent jobagent canary [--live <posting url>]   # dry-fill every adapter against its recorded form; --live also reads one real form (types nothing)
uv run --project agent jobagent bench screen --data <data folder>   # replay the early filters on a data folder; prints counts only
```

- Adapters live in `agent/jobagent/ats/`. Greenhouse reads its form from the public API; Lever, Ashby and the systems in `ats/more.py` (Breezy, Recruitee, Rippling) have no form API, so `ats/formscan.py` scans the rendered form into the same `fields.json` rows. Every adapter checks for CAPTCHAs and logins (the job goes to "Needs you"), never presses Enter, and only `safety.click_submit` clicks Submit. The Lever and Ashby fixtures in `agent/tests/fixtures` were built from those sites' public markup, not recorded byte for byte, and their submit and confirmation path is not verified live: run `jobagent canary --live <url>` against a real posting after a site redesign.
- `jobagent resolve <job_id>` upgrades a job-site or company-page listing to the employer's fillable posting (it keeps the job id and stores `resolved_from` in `meta.json`).
