---
name: followup-email
description: Handle a `followup` task. Draft a short, polite follow-up email for an application the user already sent, from analysis.json and the profile, and show it in Telegram to copy. Never sends anything.
---

# Follow-up email

Task data: `{job_id}`. Commands: `uv run --project agent jobagent ...`. You never read `posting.md`.

1. `jobagent job get <job_id>`. It should be `SUBMITTED` or `APPLIED_SELF`. Otherwise `tg_send` (`tone: info`, one line: there is no sent application to follow up on) and stop.
2. Read `data/jobs/<job_id>/analysis.json` (company, role, reasons) and the Contact section of `data/profile.md` (the name to sign with). Use the job's history for when they applied.
3. Write the email: a subject line and at most 120 words. Thank them, restate interest in the role by name, give **one** concrete reason they fit (from the analysis `reasons`, true profile facts only), ask politely about next steps, sign with the user's name. No pressure, no invented facts, no "I am excited" filler.
4. `tg_send` with `tone: success`, title `Your follow-up for <company>` (escaped), and the email inside `<pre>…</pre>` so it is one tap to copy (escape `&`, `<`, `>`). Add one `<i>` line: "Send it to the recruiter or hiring manager if you have their email; I never send emails myself." `buttons: ["J:a:0"]`. Stop.

## Never

Do not send an email or contact anyone. Do not run `submit`. Do not put posting text in the message.
