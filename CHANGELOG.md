# Changelog

## 4.0.0 (not released yet)

### What changed

- **Far less of your Claude limit per job.** The app now runs each job itself and asks Claude only for single judgments, instead of one long Claude session per job.
- **Jobs you can't take are dropped early.** Wrong country, pay below your minimum, wrong level or job type are filtered by code, then one quick call sorts the rest. **🔎 Filtered out** shows each one with the reason.
- **🤖 Autopilot.** One choice makes JobAgent search, prepare and send the strong matches by itself, with a daily limit, a pause after two failed sends, and one quiet summary a day.
- **Your first 3 real applications on each form type wait for you.**
- **Less upkeep.** Unanswered auto-search jobs close after a week, old files are cleared, and a new version installs with one tap from Health.
- **Smaller things:** say why you skipped a job; setup asks your expected salary once; your resume lines are indexed as soon as you add a resume; Insights shows what a prepared application costs; the Job site logins screen opens at once.
- **Upgrading from 2.x:** `jobagent migrate` brings your data over (see the README). Practice mode and settings carry over.

### Safety

- Posting text, form labels and resume text go only to Claude calls that have no tools, and code checks every answer before it is used.
- A posting that tries to give instructions is never sent without you.

### Removed

- The Claude skills that ran job work step by step (reading a posting, tailoring, preparing the review, changes, resume reading, follow-ups), the posting-analyst agent, and the Telegram tools only they used.

### Measured against 2.x

Baseline: one real 2.x install, 37 jobs over three days.

| Measure | 2.x | Target | 4.0 |
|---|---|---|---|
| Claude sessions with tools, per job | 1 (17.6 tool steps) | 0 | 0 (tests) |
| Claude calls for a job the filters drop | 1 full session | 0 | 0 (dropped before any call) |
| Claude calls for a job that reaches review | 1 session, up to 38 steps | 4 or fewer | 3 on the normal path; retries can add more. Not measured on real jobs |
| Limit used by a job that reaches review | 22 to 46 % of the 5-hour window | a quarter of that or less | not measured |
| Time from link to review card | up to 153 s | 120 s or less | not measured |
| The 31 jobs 2.x analysed and then dropped | 0 dropped early | 20+ by the filters, 26+ with the quick sort | 29 of the 37 jobs dropped by the filters, every one a job 2.x had skipped. With the quick sort: not measured |
| The 6 jobs 2.x's rules kept | | 0 dropped by the filters | neither of the good matches was dropped; the other kept jobs were not counted separately |
| Permission denials during job work | in 15 of 38 tasks | 0 | none possible (the calls have no tools); not measured on real jobs |
| Slow taps on question forms and job site logins | 6 of 105 taps overall | 0 | not measured on a real install (these screens no longer wait for Python) |
