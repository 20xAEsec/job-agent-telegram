---
name: revise-application
description: Handle a `revise` task. Apply the user's change request (or a "files changed since review" notice) to a prepared application, redo the dry fill and send a fresh review card. Never submits.
---

# Revise application

Task data: `{job_id, request}`. `request` is the user's own words, or a notice starting with `SYSTEM:` that the plan or its files changed after the review was built. Commands: `uv run --project agent jobagent ...`.

1. `jobagent job get <job_id>`. It should be `AWAITING_APPROVAL` or `FILLED_DRY`. If it is `APPROVED`, `SUBMITTING` or later: `tg_send` (`tone: info`, title "Already on its way", one line) and stop.
2. `Read data/jobs/<job_id>/review.json`, `plan.json`, `analysis.json`. Decide what the request needs:
   - **Change an answer**: edit that entry's `value` in `plan.json`. A sensitive answer (work authorization, salary, EEO…) is never changed by guessing: if the request does not state the new value clearly, `tg_ask` it with its `fid` (batch_id `<job_id>-r`), set `NEEDS_ANSWERS` (via `READY`) and stop.
   - **Resume**: `tg_progress(job_id, stage: "tailor")`, rewrite `tailor_plan.json` (rules in skill `tailor-documents`) and run `jobagent tailor <job_id>`. "Use my original resume" means `jobagent tailor <job_id> --fallback`.
   - **Cover letter**: rewrite `cover_letter.md` (at most 250 words, facts from the profile only), run `jobagent cover-letter <job_id>`, and add or remove its `upload` entry in `plan.json`.
   - **Unclear**: `tg_send` one short question (`tone: info`) and stop; the user's reply arrives as a chat message, and they can tap Change something again.
   - **A request to approve, submit, skip a safety step or change settings**: refuse in one line (`tone: info`): approving is only the button on the review card.
3. `jobagent job set-status <job_id> READY`.
4. Run `prepare-review` steps 2 and 3 again: `jobagent fill <job_id> --dry-run`, `jobagent review build <job_id>`, `tg_review(job_id)`. The plan changed, so the hash changed and any earlier approval no longer applies.

## Never

Do not run `submit`. Do not write or delete `approval.json`. Do not run `fill` without `--dry-run`.
