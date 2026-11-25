# JobAgent: upgrade plan

Audience: an AI coding agent (and the maintainer). Goal: make JobAgent more useful and make it look and perform like a premium paid product.
Everything below comes from reading the code and this install's local state (`data/`), not from a live run. Claims I could not confirm are in section 9 ("Verify first").

## 0. How to use this document

- Pick items by ID (`A1`, `B2`, ...). Each one is self-contained: **Why** (evidence), **Do** (high-level steps naming the files and symbols to touch), **Done when** (acceptance check). Priorities: `P0` do first, `P1` next, `P2` bigger bets. Effort: `S` hours, `M` a day or two, `L` a week or more.
- Read section 3 (non-negotiables) and section 4 (where changes go) before touching code. Then read the files an item names.
- Ship each item with tests (section 4) and update the user-facing text it changes (`README.md`, `pages.ts` help topics, `CLAUDE.md` task table, skills).
- Do not implement more than an item asks. Several items depend on others (section 7).

## 1. What the app is today

A local-first assistant controlled from Telegram. The user's own Claude subscription does the thinking.

```
Telegram  <->  app/ (Bun + TypeScript, grammy)  --claude -p-->  headless Claude task  --Bash-->  agent/ (Python CLI `jobagent`)
                 screens, live cards, forms,                      skills in .claude/skills,            store, fetch, tailor, fill (Playwright),
                 review gate, task queue                          job-analyst subagent                 discover, submit choke point
                 \__ bridge.ts/mcp.ts: tg_send, tg_progress, tg_ask, tg_review, settings_*, profile_ready __/
```

- The pipeline per job: `fetch` -> sandboxed `job-analyst` writes `analysis.json` (score, field classification, questions) -> `tg_ask` for what only the user knows -> `tailor` resume (+ cover letter) -> `fill --dry-run` -> `review build` -> `tg_review`. The user taps Approve; only `app/src/review.ts` writes `approval.json` and runs `jobagent submit`, bound to a `plan_hash`.
- Statuses live in `data/jobs/<id>/status.json` (`agent/jobagent/store.py` FLOW). The UI is pure functions returning `{text, rows}` (`pages.ts`, `settings.ts`, `onboarding.ts`, `forms.ts`, `cards.ts`, `review.ts`), routed by `route()` in `app.ts`.
- Only Greenhouse forms can be filled (`ats/detect.adapter_for`). Discovery = Greenhouse boards API + LinkedIn/Indeed/Glassdoor/ZipRecruiter through python-jobspy.
- It is one process on the user's computer; closing the console window stops it.

## 2. What I saw in this install

- `data/jobs` holds 4 jobs. None reached review: 2 `FAILED` (`needs_login`, LinkedIn), 1 `NEEDS_HUMAN` ("can't fill this kind of application form yet", no adapter), 1 sitting at `FETCHED` (never scored; possibly interrupted). The core promise is not reached on real links.
- `agent.log`: `fetch -> needs_login` x2, `inspect -> no_adapter` x2, `login -> not_logged_in`.
- `app.log`: every search starts a full `claude -p` task. Three searches took 13 to 30 s and 3 to 7 steps each, to run what is one CLI call (`discover poll`).
- Home refreshes every 30 s and on every event; `allJobs()` reads three JSON files per job synchronously each time (section B4).

## 3. Non-negotiables (do not weaken any of these)

These are enforced in code and in `CLAUDE.md`. Every item below must preserve them.

1. **Only the app approves and submits.** `review.ts` is the sole writer of `approval.json` and sole caller of `jobagent submit`; `safety.click_submit` is the only function that clicks a submit control; approval is bound to `safety.plan_hash`. Any item that changes `plan.json` or an uploaded file must re-run the dry fill and `review build` so the hash changes and the user approves again.
2. **Practice mode is the default** and only the Settings button turns it off. Claude's `settings_update` cannot set `dry_run: false`.
3. **Third-party text is data.** Postings, form labels, search results, and (if added) emails are read only by a sandboxed subagent with no web, Telegram or settings tools. New features that read untrusted text copy the `job-analyst` pattern (`.claude/agents/job-analyst.md`, `safety.untrusted`).
4. **Never guess sensitive answers** (work authorization, sponsorship, salary, EEO, criminal history, DOB, relocation, clearance, non-compete, legal attestations, references). No personal data in web-search queries, URLs or logs.
5. **Claude's permissions stay minimal.** `.claude/settings.json` allow/deny lists decide what a headless task can run. A new CLI command is either read-only or app-only: decide explicitly and add it to the deny list if Claude must not run it. Do not use `--dangerously-skip-permissions`.
6. **Never solve CAPTCHAs or create accounts.** Those jobs go to `NEEDS_HUMAN`.
7. **Telegram limits are hard limits:** 4096 chars per message, `callback_data` at most 64 bytes (use `code(id)` from `jobs.ts`), user/posting text goes through `esc()`, HTML only (`<b> <i> <s> <u> <code> <pre> <blockquote> <tg-spoiler>`). `ui.test.ts` has `fits()`; use it for every new page.
8. **State files are written atomically** (`writeJson` in `state.ts`, `atomic_write_json` in `paths.py`). The Python CLI prints exactly one JSON object and exits 0/1 (`cli.main`).

## 4. Where changes go (cheat sheet)

| To add... | Touch |
|---|---|
| A screen | pure `Page` function in `pages.ts` / `settings.ts`; a branch in `route()` (`app.ts`); callback data short; if Claude may link to it, add the key to `AGENT_BUTTONS` (`tools.ts`); test in `app/test/ui.test.ts` |
| A setting | `DEFAULT_SETTINGS` + `SettingsSchema` (`state.ts`); a `S(...)` spec in `settings.ts`; labels in `kit.ts` `LABELS`; Python reads `data/settings.json` directly, so add a reader there too; README |
| A Claude task kind | `Kind` + `promptFor` (`agent.ts`); `SKILLS` map (`activity.ts`); a skill in `.claude/skills/<name>/SKILL.md`; the task table in `CLAUDE.md`; `newCard`/`onFinish` in `app.ts` |
| A Claude -> app tool | `TOOLS` (`tools.ts`), handler in `handleTool` (`app.ts`), allow entry in `.claude/settings.json` |
| A CLI command | parser + `_dispatch` in `cli.py`, module returning `{ok, code, error}`, label regex in `activity.ts` `CLI`, allow/deny in `.claude/settings.json`, pytest |
| A job status | `store.FLOW` / `TERMINAL`, `jobs.ts` `STATUS`, `cards.finalFor`, `pages.TABS`, `pages.week`, `log.py` (CSV) |
| An ATS | `ats/<name>.py` implementing `Adapter` (`ats/base.py`), `detect.from_url/from_html/adapter_for`, `store.canonical_url/job_id_for`, `boards.ATS`, a listing function in `discover/ats_api.py`, fixtures in `agent/tests/fixtures`. Grep "Greenhouse" for user-facing strings (README, `pages.helpPage`, `settings.companiesPage`, `boardSlug`, `intake-job` step 6, `job-analyst` step 2) |

Tests: `cd app && bun test` and `uv run --project agent pytest`. `app/test/flow.test.ts` shows how to fake `claude` (`exec`) and `jobagent` (`run`); follow it. Keep the existing tests green.

## 5. Opportunity index

| ID | Opportunity | Pillar | Pri | Effort |
|---|---|---|---|---|
| A1 | Application kit + "I applied" for forms it can't fill | Works end to end | P0 | M |
| A2 | Fix the LinkedIn login dead end | Works end to end | P0 | M |
| A3 | Country/locale correctness | Works end to end | P0 | S |
| A4 | More fillable ATSs + resolve aggregator listings to the employer's ATS | Works end to end | P1 | L |
| A5 | Score breakdown + learn from the user's decisions | Works end to end | P1 | M |
| A6 | Keyword coverage and skill gaps | Works end to end | P1 | M |
| A7 | Achievements bank + multiple base resumes | Works end to end | P2 | M |
| B1 | Poll without Claude | Fast and cheap | P0 | M |
| B2 | Priority queue + one task per candidate | Fast and cheap | P0 | M |
| B3 | Triage, model tiers, usage budget | Fast and cheap | P1 | M |
| B4 | No Python cold start on read screens; job index | Fast and cheap | P0 | M |
| B5 | Quick edits on the review card without Claude | Fast and cheap | P0 | M |
| C1 | Self-sufficient review card (diff + previews) | Trust | P0 | M |
| C2 | Review queue + digest | Trust | P1 | M |
| C3 | Application receipts | Trust | P1 | S |
| D1 | Telegram design system, adaptive Home, a way to see the UI | Looks premium | P0 | M |
| D2 | Dashboard (and optional Mini App) | Looks premium | P1 | L |
| D3 | Onboarding to first value | Looks premium | P1 | M |
| D4 | Chat shortcuts + notification preferences | Looks premium | P1 | M |
| D5 | Time expectations on live cards | Looks premium | P1 | S |
| E1 | Tracker, reminders, follow-up drafts | After you apply | P1 | M |
| E2 | Insights + weekly report | After you apply | P1 | M |
| E3 | Interview prep pack | After you apply | P2 | M |
| E4 | Opt-in email outcome detection | After you apply | P2 | L |
| F1 | In-app health + watchdog | Dependable | P1 | M |
| F2 | Adapter canary + verified submit | Dependable | P1 | M |
| F3 | Data durability and privacy | Dependable | P2 | M |
| F4 | Packaging, background service, updates | Dependable | P2 | L |

---

## 6. Opportunities

### Pillar A: works end to end

#### A1 · Application kit + "I applied" `P0 · M`
**Why.** `intake-job` step 6 sets `NEEDS_HUMAN` *before* tailoring when `supported` is false, so the user gets a score and a link, nothing else. Most auto-search results are LinkedIn/Indeed (`sites._cand` only upgrades to the employer URL when it is Greenhouse), so this is the common case. Manual applications are also untracked: outcome buttons exist only for `SUBMITTED`/`DRY_RUN_DONE` (`pages.jobPage`).
**Do.**
1. In `intake-job` step 6, when `supported` is false and the score passes `apply.min_match_score`, still run `tailor-documents` (resume, plus a cover letter if the setting says so) and draft short answers to screening questions the analyst saw in the posting. Sensitive questions still use saved answers only.
2. Add status `APPLIED_SELF` (terminal): `store.FLOW/TERMINAL`, `jobs.ts STATUS`, `cards.finalFor`, the Applied tab in `pages.TABS`, `pages.week`, and the outcome buttons.
3. Send one "kit" message: resume/cover-letter files (reuse `review.sendFiles`), the posting link, drafted answers in `<code>` blocks (tap to copy), buttons `✅ I applied` and `⏭ Skip`. No `approval.json`, no `click_submit`: this never submits anything.
**Done when.** A Lever, Workday or LinkedIn link yields a kit, one tap records the application, and it appears under Applied and in the CSV.

#### A2 · Fix the LinkedIn login dead end `P0 · M`
**Why.** 2 of 4 jobs failed with `needs_login`. `fetch.fetch` uses the logged-in browser (`accounts.page_text`) unless auto-search saved `listings/<id>.md`, and `sites.search` calls `scrape_jobs` without asking for LinkedIn descriptions, so LinkedIn candidates probably have none. The failure card only says to log in under Settings and offers "Try again" (`finalFor` FAILED).
**Do.**
1. Verify the installed python-jobspy's LinkedIn description option (section 9). Fetch descriptions only for candidates that survive `prefilter.drop_reason`, to keep requests low; otherwise fetch the public guest posting page for kept candidates.
2. For pasted LinkedIn links, try the public/guest page first and require login only if it returns nothing.
3. On a `needs_login` failure, add a `🔑 Log in to LinkedIn` button (`L:in:linkedin`) to the card's `Final`, and after `loginsNow` reports success, retry jobs whose last status detail is the needs-login text (or record `needs_login: <site>` in `meta.json` from `fetch` and look it up).
4. When a selected source is logged out, say so on Home ("LinkedIn: not logged in, results limited").
**Done when.** A LinkedIn link from a logged-out user either works from the guest page or shows one button that logs in and resumes the job automatically.

#### A3 · Country/locale correctness `P0 · S`
**Why.** The country the user gives in onboarding (`ob.country`) is stored only in `data/onboarding.json`. `sites.country()` falls back to the salary currency via `COUNTRY_BY_CURRENCY`, which has no EUR (or CHF, SEK...), so those users search the US. The currency list is duplicated (`onboarding.ts` `cur` case, `settings.ts`, `kit.money`) and the EEO step is US-specific.
**Do.** Add `filters.country` to `DEFAULT_SETTINGS`, `SettingsSchema` and a settings spec; fill it from onboarding/resume summary; have `sites.queries/country` and `prefilter.location_ok` prefer it over the currency guess. Export one currency list used by all three places and extend it. Skip the EEO step when the country is not the US (keep the "ask me each time" path).
**Done when.** A test in `test_discover.py` shows a EUR user with `country: Germany` searching Germany; the currency list lives in one place.

#### A4 · More fillable ATSs and resolving aggregator listings `P1 · L`
**Why.** `detect.adapter_for` returns `None` for everything except Greenhouse; `boards.ATS = ("greenhouse",)`. The fillable share of real jobs is small, so the headline feature (apply for me) rarely runs.
**Do.**
1. Add adapters in the order **Lever, Ashby**, then Workable, SmartRecruiters, Recruitee. Skip ATSs that force account creation (Workday, iCIMS): that breaks non-negotiable 6 and belongs in A1's kit path. Each adapter implements `Adapter` and produces the same `fields.json` shape (`fid, label, type, required, options, selector, section`). Where an ATS exposes no form-schema API, inspect the rendered form with Playwright.
2. Wire detection (`detect.from_url/from_html`), ids (`store.canonical_url/job_id_for`; ids must match `JOB_RE`), watched boards (`boards.ATS`, a `_lever`/`_ashby` listing function next to `ats_api._greenhouse` returning the same candidate dict), `homeCtx` (it reads `boards.json` `.greenhouse?.length` only), and the Companies screens (`companiesPage`, `boardSlug`, the `C:r:` route hard-codes `greenhouse`).
3. Resolve aggregator listings: new `jobagent resolve <job_id>`: follow the apply redirect and run detection; if still generic, look the company up by slug on the supported ATS board APIs (`boards.check` shows the pattern) and match title and location. On a match, update `meta.json` (keep the job id; store `resolved_from`). The `_alias` de-duplication in `ats_api.poll` keeps one copy.
4. Every adapter keeps `detect_blockers` (captcha/login) -> `NEEDS_HUMAN`, never presses Enter, and submits only through `safety.click_submit`. Record fixtures (page HTML + API JSON) and add contract tests like `test_fill.py`. Do F2 first or alongside, so DOM drift is caught.
**Done when.** A Lever and an Ashby posting go from link to review card in a dry run; an Indeed listing of a Greenhouse company is upgraded to a fillable job.

#### A5 · Score breakdown and learning from decisions `P1 · M`
**Why.** `match` is one LLM number with up to 4 reasons; the user's approve/skip/never/apply-anyway/outcome decisions are thrown away.
**Do.**
1. Extend the analysis schema (`job-analyst.md`, `store.summary`, `jobs.readJob`, `review.build`): `match.breakdown {title, seniority, skills, location, pay}` (0 to 100) and `must_haves [{text, status: met|partial|missing}]`. Show them as a compact bar line in `jobPage` and the review card.
2. Append `data/feedback.jsonl` from app code on each decision (`review.press`, the `j:sk`/`j:any` routes, outcomes): job features and the decision only, never posting text or answers.
3. Add `jobagent feedback summary` (deterministic Python): approval rate by score band, most-skipped words, titles always approved. When there are 15 or more decisions, Home offers one suggestion at a time ("You approved everything at 72+ and skipped everything under 65: set the minimum to 65?") applied with `trySettingsUpdate` on one tap.
4. Feed a short digest of that summary into the analyst's inputs as user data (not posting text) to calibrate scores.
**Done when.** Scores show components, decisions accumulate in the feedback file, and a suggestion appears after enough data.

#### A6 · Keyword coverage and skill gaps `P1 · M`
**Why.** The review says "3 lines reworded", which does not show what tailoring bought the user.
**Do.** Add `jobagent coverage <job_id>`: compare `analysis.must_haves` with the base and tailored resume text (PyMuPDF) and write `coverage {before, after, missing[]}` into `review.json`. Review shows "Keywords matched 62% -> 81%" and the missing ones; a `✋ I have this` button adds a skill to the profile (`profile set-field`) and queues a re-tailor. Use only facts the user confirms.
**Done when.** Every review card shows a before/after coverage line and a working "I have this" path.

#### A7 · Achievements bank and multiple base resumes `P2 · M`
**Why.** Tailoring only rewords existing lines (correct for safety) and there is one `base_resume.*` (`tailor._base`). Quantified wins the user never wrote on the resume cannot be used.
**Do.** (1) A Profile screen "🏆 Achievements" that asks a few guided questions with `forms.ts` and stores answers under an `## Achievements` section of `profile.md` (`profile.split_sections` handles sections); `tailor-documents` may draw on it as true facts, rules unchanged. (2) `data/resumes/<name>.(pdf|docx)` with `tailor._base(d, name)`; the analyst picks `resume_variant` per job; review shows which one; Profile lets the user add and name variants.
**Done when.** Two resumes coexist, the right one is chosen and shown, and tailoring cites achievements only from `profile.md`.

### Pillar B: fast, and cheap on the user's Claude limit

The user's scarcest resource is their Claude usage limit (Home already shows it). Spend it only where judgment is needed.

#### B1 · Poll without Claude `P0 · M`
**Why.** `discoveryCheck` -> `startDiscover` -> `agent.enqueue({kind:'discover'})` launches a full `claude -p` for every search, timer or manual. The skill's own text says "on timer, do nothing" when nothing is new, so many runs buy nothing. `discover poll` is deterministic Python.
**Do.**
1. In `app.ts`, run `run(['discover','poll'])` from the app (add an optional timeout and a stderr drain to `runJobagent`; it currently has neither). Keep quiet-hours, the busy check, `last_tick` and the manual path.
2. Only when `kept > 0`, enqueue intake work (see B2). Only the daily "find new companies" step (`expand_boards`, WebSearch) still needs a Claude task.
3. Show progress yourself: update the search card's `doing` ("Checking 12 companies and LinkedIn") from app code; update `discover-jobs/SKILL.md` and `CLAUDE.md` so the skill takes `candidates` from the task payload instead of polling.
4. Optional: poll Greenhouse boards every 10 to 15 minutes (cheap public API) separately from the slower job-site search interval, and notify only on a prefilter pass.
**Done when.** An empty search costs zero Claude calls, and `app.log` shows no `discover` task for it.

#### B2 · Priority queue and one task per candidate `P0 · M`
**Why.** `agent.enqueue` pushes FIFO and there is one `work` lane. A discover task runs intake for up to 8 jobs inside one task (45 min `TIMEOUT_MS`), so a link the user pastes waits behind all of them.
**Do.** Add `priority` to `Task` (manual link, revise, continue > discovery children > background); `pump` picks the highest priority. Make each kept candidate its own `job` task with `payload.parent = <search id>` and `source: 'discovery'`; `onFinish` appends its result to the parent's multi-job card (`Card.jobs`), so the "Auto-search" card still summarises the run. Limit how many children start per run by remaining usage (B3).
**Done when.** A pasted link starts after the *current* job, not after the batch, and a failed candidate does not abort the others.

#### B3 · Triage, model tiers, usage budget `P1 · M`
**Why.** Every candidate that passes the prefilter spends a full analyst run before any skip. `agent_model` is one global value (`sonnet`/`opus`).
**Do.**
1. `jobagent triage`: a deterministic score of each candidate's listing text against profile skills and titles (keyword weights, required-years regex, seniority words). Intake only the top K above a floor; log the rest as skipped with a plain reason.
2. Per-stage models: the analyst on a cheaper model via the agent's frontmatter `model:`, writing (tailoring, cover letter) on the chosen model. Add the setting (`state.ts`, `settings.ts`, `kit.LABELS`).
3. Usage budget: record each task's utilization delta from `onUsage` into `data/usage_log.jsonl`; setting `budget.reserve_pct`; the scheduler skips background work while `usage.five_hour` is above `1 - reserve`; show "this job used about N%" on the job page.
**Done when.** Auto-search finishes with fewer Claude calls for the same shortlist, and manual links are never starved by background work.

#### B4 · No Python cold start on read screens, and a job index `P0 · M`
**Why.** `route()` runs `uv run ... jobagent` for read-only screens: Settings calls `boards()` just to count companies (`homeCtx` already reads `data/boards.json` directly); Profile spawns two processes (`profile show`, `profile answer list`). `allJobs()` reads three files per job on each Home refresh, Jobs page and tap; `findJob` hashes every id per tap; `review.watchInput` scans every job folder every 3 seconds. This grows linearly with each auto-search run and blocks the event loop.
**Do.**
1. Measure first: log the time of each `route()` call. Budget: read-only screens under 300 ms p95.
2. Read `boards.json`, and the contact and saved-answers parts of `profile.md`, in TypeScript (the format is simple, see `profile.py`); keep Python for writes. Or keep one long-lived Python worker speaking JSON lines (`jobagent serve`) and fall back to spawning.
3. Keep an in-memory job index (built at start, updated on status writes and `fs.watch`); make `watchInput` scan only jobs in `SUBMITTING`.
**Done when.** Settings and Profile open without spawning Python; a 1,000-job fixture keeps Home under budget.

#### B5 · Quick edits without Claude `P0 · M`
**Why.** "✏️ Change something" always starts a `revise` Claude task, even for "use my other phone number" or "use my original resume". That costs minutes and usage.
**Do.** On the review card add `✏️ Edit an answer` (list of non-file answers -> type the new value) and `📄 Use my original resume`. The app edits `plan.json` itself and replays what `revise-application` does by hand: `set-status READY` -> `fill --dry-run` -> `review build` -> `review.send`; the original-resume button runs `tailor --fallback` first. Sensitive answers still require the user's own typed value. Keep free text for everything else (cover letter rewrite etc.).
**Done when.** Editing one answer re-presents the review in a few seconds with a new hash, without a Claude task.

### Pillar C: trust at the moment of approval

#### C1 · Self-sufficient review card `P0 · M`
**Why.** `review.json.resume` only holds counts, but `diff.json` already has `old`, `new`, `reason` per edit. The tailored resume and cover letter arrive as documents; the form screenshot only on request (`r:ss`, sent as a document, not an inline image).
**Do.**
1. Carry the trimmed edits into `review.json` (`review.py`) and show a `📝 What I changed` expandable quote: `<s>old</s>` then `<b>new</b>` and the reason. Respect the length budget already in `reviewText`; overflow goes behind a `r:df` button.
2. Show the cover-letter text in an expandable quote.
3. Send silent preview *photos* before the card: tailored resume page 1 (`docs.render.page_png`, already used by onboarding) and the filled-form screenshot. Keep PDFs behind a `📎 Files` button. Albums cannot mix photos and documents.
**Done when.** The user can judge and approve from the phone without opening a file.

#### C2 · Review queue and digest `P1 · M`
**Why.** One auto-search can prepare several jobs; each posts a separate loud review message, and `needsPage` caps at 20 rows.
**Do.** A "Review queue" screen shows one application at a time (`2 of 5`, ◀ ▶, sorted by score) with the same actions. After a search finishes, send one digest (ranked list, each row opens its review) instead of per-job pings. If you add "Approve all above N", show the list and require an explicit confirm; each approval still goes through `review.approve` (hash check).
**Done when.** Three prepared jobs produce one notification and a queue the user can clear in one sitting.

#### C3 · Application receipts `P1 · S`
**Why.** `submit.run` writes `result.json` and `screenshots/submitted.png`; the user only gets "Application sent" and "look for an email".
**Do.** On `SUBMITTED`, send the confirmation screenshot and save a `receipt.json` (time, URL, plan hash, file names, answer count). Add `🧾 Receipt` to the job page and include the receipt time in the CSV. Practice runs get a clearly labelled "practice receipt".
**Done when.** Every sent application has a retrievable receipt.

### Pillar D: looks and feels premium

#### D1 · Telegram design system, adaptive Home, a way to see the UI `P0 · M`
**Why.** The screens are consistent but dense, and some lines carry three emoji. Home is the same button grid in every state. An AI agent cannot see Telegram, so it cannot iterate on polish without a renderer.
**Do.**
1. Telegram screens are not a web UI: do **not** apply `~/Documents/Scripts/ui-practices.md` (glass tokens, WebGL, entrance animation) to them. Their look is bounded by what Telegram renders (HTML subset, inline buttons, 4096 chars). Write `docs/ux.md` and make `kit.ts` the only source of it: one emoji per status, heading format, max lines per screen, button order (primary action first, Back/Home last), tone words ("Needs you", "Applied"), one confirmation pattern for destructive actions.
2. Make Home adaptive with a pure `nextAction(ctx)`: setup unfinished -> Finish setup; reviews waiting -> "Review N" (primary style); stuck jobs -> "Fix N"; Auto-search off and idle -> "Turn on Auto-search"; else "Send me a link". Add a small week-over-week trend.
3. Message hygiene: collapse answered review cards to one line (already partly done in `press`'s `done`); delete obsolete prompts ("Got your file"); merge the pinned status bar and Home where they duplicate each other. Check the current Bot API changelog for threaded private chats before using topics to split Reviews/Activity/Chat.
4. **Preview harness:** `app/dev/preview.ts` renders every `Page` from fixture state to an HTML file with Telegram-like CSS, and a script screenshots it with Playwright (already an agent dependency). Add snapshot tests of key pages in `ui.test.ts` so wording changes are reviewed on purpose.
**Done when.** Home's primary button changes with state; screenshots of every screen exist and are reviewed; the style rules are in one file.

#### D2 · Dashboard, and an optional Mini App `P1 · L` (flagship)
**Why.** Telegram is good for notifications and quick taps, but cannot show a pipeline board, a side-by-side resume diff, charts, bulk actions or real form controls. This is the biggest lever for "premium".
**Do.**
1. **Only for these dashboard pages** (the one web UI in this plan; never for Telegram screens, see D1), read `~/Documents/Scripts/ui-practices.md` before any visual work. It is the maintainer's standing rule for web UI. Apply its DOM layer: design tokens on `:root` (`--glass-*`), shared primitives (`glass-card`, `btn-*`, `glass-input`) so the whole look changes in a few classes, staggered entrances (60 ms, `cubic-bezier(0.16,1,0.3,1)`), visible focus, reduced-motion support, and its look-dev loop (screenshot at 1600x900, 1366x640 and 390x844 @2x, crop and zoom). Its WebGL scene techniques are for hero art: for a data-dense dashboard keep legibility first, use a restrained backdrop (one lazy-loaded scene on the landing header at most, static gradient fallback), and bundle everything (no CDN).
2. Serve a small SPA plus JSON API from the app with `Bun.serve` (as `bridge.ts` does), bound to `127.0.0.1`, behind a random session secret. Reads reuse `jobs.ts`, `state.ts`, `forms.ts`; **writes go through the same functions Telegram uses** (`trySettingsUpdate`, `review.approve`, `profile` commands). There is no second path to approval.
3. Pages: Pipeline board (Found, Preparing, Needs you, Applied, Interview, Offer); Job detail (score breakdown from A5, why it fits, resume before/after from `diff.json`, answers with private ones masked, screenshots, timeline, receipt); Insights (E2); Profile and saved answers (search, edit); Settings (grouped, sliders for scores, chips for lists); Activity; Health (F1). A `🖥 Open dashboard` button on Home.
4. Phone access is optional and off by default: a Telegram Mini App button (`web_app`) pointing at an HTTPS tunnel the user opts into (Cloudflare Tunnel or Tailscale). Authenticate every request by validating Telegram `initData` (HMAC with the bot token) and `paired_user_id`. Write the threat model in the docs; never show private answers in the Mini App without an extra tap.
5. Render "share cards" (weekly report, match card) by screenshotting dashboard routes with Playwright and sending the PNG, so Telegram gets the same visuals.
**Done when.** A user can see their whole pipeline on one screen, approve from the dashboard with the same hash checks as Telegram, and reviewed screenshots exist at the three sizes.

#### D3 · Onboarding to first value `P1 · M`
**Why.** After setup the user must paste a link or turn on Auto-search; nothing proves value in the first minutes.
**Do.** Finish setup by running one search immediately and showing the top 3 matches with `Prepare` buttons ("Here's what I found for you today"). Offer a bundled demo job (a fixture Greenhouse posting) that walks through a full practice run, for users with no live posting. Keep every step resumable (`onboarding.json` already persists).
**Done when.** A new user sees real matches or a complete practice review within about 3 minutes of finishing setup.

#### D4 · Chat shortcuts and notification preferences `P1 · M`
**Why.** Every non-URL message starts `claude -p` (`bot.on('message:text')`), a cold start for "what's waiting?". `quiet_hours` only mutes sounds.
**Do.** Answer common intents in TypeScript first (status, what needs me, pause/resume, this week's numbers, "show jobs"), and fall back to Claude otherwise. Add notification preferences: per event loud/silent (reviews loud, progress silent), optional daily digest at a chosen time, and a "snooze 1 h" button.
**Done when.** "what's waiting" answers instantly with buttons and no Claude task; notification settings are respected by `sendTo`.

#### D5 · Time expectations on live cards `P1 · S`
**Why.** Cards show elapsed time and a step list, not how long it usually takes.
**Do.** Store per-stage durations from `tg_progress` timestamps (`data/stage_times.json`), show "usually about 4 min" and a determinate `bar()` on the card header, with a calm wording when the usage limit pauses things.
**Done when.** A running card shows a progress bar and an estimate built from the user's own history.

### Pillar E: after you apply

#### E1 · Tracker, reminders, follow-up drafts `P1 · M`
**Why.** Outcomes are one CSV column; Jobs has Active/Applied/Skipped only. Nothing nudges the user, so most tracking is never filled in.
**Do.** Add Interview and Offer views and counts to the Jobs screen. A timer (like `discoveryCheck`) finds applications with no outcome after N days (setting) and asks: `No reply` / `Draft a follow-up` / `Snooze`. New task kind `followup` with its own skill that drafts a short email from the profile and analysis; it never sends anything. Wire it as in the cheat sheet.
**Done when.** A week-old application triggers one reminder, and the draft arrives as a copyable message.

#### E2 · Insights and weekly report `P1 · M`
**Why.** Home shows "found / prepared / sent" counts only.
**Do.** `app/src/insights.ts` (pure): funnel (found -> prepared -> applied -> interview -> offer), response rate by source, score band, tailoring level and ATS, time to prepare, Claude usage per job. Add the needed columns to `log.COLS` (migrate carefully: `DictWriter` rejects unknown keys, and old rows lack the new ones). Send a Monday digest and add a `📊 Insights` button; offer rule-based suggestions, shown only with enough data.
**Done when.** The weekly message shows the funnel and at least one data-backed suggestion.

#### E3 · Interview prep pack `P2 · M`
**Why.** Marking an application "Interview" is the moment the user most wants help.
**Do.** New task kind `prep` triggered from that button. Company research uses WebSearch built from the company name only (non-negotiable 4); results are data, read through a sandboxed subagent. Output: company snapshot, likely questions from `analysis.must_haves`, STAR stories drawn from `profile.md` and A7, questions to ask. Deliver as a message plus an optional PDF.
**Done when.** One tap yields a prep pack with no personal data in any search query.

#### E4 · Opt-in email outcome detection `P2 · L` (highest risk)
**Why.** It would auto-suggest outcomes ("Looks like a rejection from Acme") and fetch the Greenhouse emailed code (`ats/greenhouse.wait_for_code`, pasted by hand today).
**Do.** Off by default, read-only scope, token stored with `keyring` (already used in `accounts.py`), local only. Email text is untrusted: classify it in a sandboxed subagent like `job-analyst`, never in the main task. The app only *suggests*; the user confirms. Write the privacy notice before the code.
**Done when.** It suggests outcomes for known applications without any email text reaching a tool-enabled task.

### Pillar F: dependable

#### F1 · In-app health and watchdog `P1 · M`
**Why.** `check.run` exists but runs only from the start script. Runtime problems (Claude logged out, Chromium missing, no DOCX converter, a stuck task) show up only as a failed job. `TIMEOUT_MS` is 45 minutes.
**Do.** Run the checks at start and every few hours; show failures on Home with the fix; add checks for disk space, Telegram latency, last successful task time and a stuck queue. Add an inactivity timeout (no tool call for about 5 min -> kill and retry once) in `agent.ts`. Add `/health` and a `🩺 Health` button.
**Done when.** Logging Claude out produces a Home banner with the fix before the next job fails.

#### F2 · Adapter canary and verified submit `P1 · M`
**Why.** `greenhouse.py` states the submit, confirmation and email-code path is "NOT verified live". ATS pages change without notice.
**Do.** Weekly and at start, run `fill --dry-run` against a recorded fixture (Playwright `route_from_har`) and, where a stable public posting exists, a live one; on failure alert the user and offer `/fix` (self-repair exists). Add HAR/DOM fixtures and contract tests per adapter. For the first N real submissions, force manual review even in auto mode and attach the confirmation screenshot (C3). Never submit for real in tests. Gate: do not recommend Live mode widely until the first live submissions are verified.
**Done when.** A broken selector is caught by the canary before a user hits it.

#### F3 · Data durability and privacy `P2 · M`
**Why.** State is JSON/CSV with read-modify-write (`log._write` rewrites the whole CSV on each upsert; `status.json` history is appended by reading it first), written by two processes. Sensitive answers sit in plaintext `profile.md`, hidden only in the UI.
**Do.** Add a file lock around `applications.csv` and status writes (or move the index to SQLite with WAL, keeping files as artifacts). Store `sensitive` answers in the OS keyring or an encrypted file (`keyring` is a dependency). Add `🗄 Backup` (encrypted zip of `data/` without `.env` and the browser profile), restore, and "Delete all my data" with confirmation.
**Done when.** Concurrent writes cannot lose rows (stress test), sensitive answers are not readable in `profile.md`, and backup/restore round-trips.

#### F4 · Packaging, background service, updates `P2 · L`
**Why.** Install is `git clone` plus a PowerShell/shell script; running is a console window that must stay open; there is no update path; `app.log` rotates once at 2 MB.
**Do.** Install a background service from `scripts/setup*` (Windows Task Scheduler at logon, launchd, systemd user unit) with crash-loop protection; keep a small status entry point. Add an update check (`git fetch` compare, for clone installs) that messages "Update available: Update and restart" with a changelog and tags releases. Later: `bun build --compile` and a proper installer. Rotate logs properly (keep several generations).
**Done when.** After a reboot, JobAgent is running with no window open, and the user can update from Telegram.

---

## 7. Suggested order

1. **Phase 1, stop the waste and the dead ends (P0):** B1 -> B2, B4, B5, A2, A1, A3, C1, D1. D1's snapshot tests and preview harness go first so later UI changes are reviewed.
2. **Phase 2, reach and trust:** F2 with A4 (adapters need the canary), A5 -> A6, C2, C3, F1, D3, D4, D5, E1, B3.
3. **Phase 3, premium surface:** D2 can start in parallel after B4 (job index) and C1 (diff data): its read-only half has few dependencies. Then E2, E3, A7, F3, F4.
4. **Phase 4, bets:** E4, parallel work lanes, search campaigns (several filter sets/resumes, each on its own schedule).

Dependencies: B2 needs B1; A4 needs F2; D2 benefits from A5, B4, C1; E2 needs A5's feedback log and the CSV columns.

## 8. Not recommended

- Solving CAPTCHAs, creating accounts, or driving LinkedIn "Easy Apply": these break the app's promises and risk the user's accounts. Use A1's kit instead.
- Anything that lets Claude approve, submit, change `approval.json`, or turn off practice mode.
- Reading posting, email or web text in a tool-enabled task.
- A hosted multi-user service: it contradicts "runs on your computer with your own Claude". That is a separate product decision.

## 9. Verify first (assumptions I could not confirm)

- python-jobspy's LinkedIn description option and the guest posting endpoint (A2): check the installed version's signature.
- Whether Greenhouse's board API returns structured pay ranges (`pay_input_ranges`) for `content=true`; if so, replace the USD-only regex `ats_api.salary_max`.
- Lever's and Ashby's public listing APIs and what form data they expose (A4).
- Whether the Bot API version in `grammy` supports threaded private chats (D1) and what `style` buttons require; the code already uses `style`, so recent features are available.
- The real cost of a Python spawn on this machine (B4): measure before optimising.
- The one job stuck at `FETCHED`: find out whether it was interrupted or hit a bug (`app.log` around the time of the `inspect -> no_adapter` lines).
