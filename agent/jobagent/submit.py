"""`submit <id>`: run ONLY by the channel server, after an Approve press or the auto-apply grace window (DESIGN 4.6).
Claude is denied this command. While dry-run is on (setting or JOBAGENT_DRY_RUN=1) it stops at DRY_RUN_DONE and opens no browser."""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import browser, safety, store
from .ats import detect
from .fill import check_plan
from .paths import atomic_write_json


def _json(p: Path):
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def company_key(d: Path, job_id: str) -> str:
    """Normalized company name, falling back to the ATS board slug (DESIGN 4.6)."""
    name = (_json(store.jdir(d, job_id) / "analysis.json") or {}).get("company") or store.meta(d, job_id).get("board") or job_id
    return re.sub(r"[^a-z0-9]", "", str(name).lower()) or job_id


def next_allowed(d: Path, job_id: str, now: datetime) -> datetime | None:
    """When this job may be submitted, or None if it may go now. Same-company spacing is the only rate limit.
    DRY_RUN_DONE never counts. Pure over files + `now`, so a restart cannot lose it."""
    hours = ((_json(d / "settings.json") or {}).get("apply") or {}).get("company_cooldown_hours", 3)
    key, until = company_key(d, job_id), None
    for x in store.list_jobs(d, deleted=True):
        if x["job_id"] == job_id or x["status"] not in ("SUBMITTING", "SUBMITTED") or company_key(d, x["job_id"]) != key:
            continue
        t = now + timedelta(minutes=5) if x["status"] == "SUBMITTING" else datetime.fromisoformat(x["updated_at"]) + timedelta(hours=hours)
        if t > now and (until is None or t > until):
            until = t
    return until


def _receipt(d: Path, job_id: str, ph: str, practice: bool) -> None:
    """receipt.json: what was sent and when (no answer values), so every application can be looked up later."""
    j, plan = store.jdir(d, job_id), _json(store.jdir(d, job_id) / "plan.json") or {}
    rows = [r for r in plan.get("fields", []) if isinstance(r, dict) and r.get("action") != "skip"]
    atomic_write_json(j / "receipt.json", {"at": store.now(), "url": store.meta(d, job_id)["canonical_url"], "plan_hash": ph, "practice": practice,
                                           "files": [r["value"] for r in rows if r.get("action") == "upload"], "answers": sum(r.get("action") != "upload" for r in rows),
                                           "screenshot": "screenshots/submitted.png" if (j / "screenshots" / "submitted.png").exists() else ""})


def _stop(d, job_id, status, code, msg, **kw):
    store.set_status(d, job_id, status, msg)
    return {"ok": False, "code": code, "error": msg, **kw}


def run(d: Path, job_id: str, prepare=None, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    j = store.jdir(d, job_id)
    if store.status(d, job_id)["status"] != "APPROVED":
        raise store.JobError("bad_status", "submit needs a job in status APPROVED")
    appr, rv = _json(j / "approval.json"), _json(j / "review.json") or {}
    if not isinstance(appr, dict):
        raise store.JobError("no_approval", "there is no approval.json: the user has not approved this application")
    try:
        ph = safety.plan_hash(j)
    except safety.SafetyError as e:
        raise store.JobError(e.code, str(e)) from e
    if appr.get("plan_hash") != ph or rv.get("plan_hash") != ph:
        raise store.JobError("hash_mismatch", "the plan changed after it was approved: it must be reviewed again")
    if safety.dry_run_on(d):  # nothing below this line runs while dry-run is on
        store.set_status(d, job_id, "SUBMITTING", "dry-run")
        store.set_status(d, job_id, "DRY_RUN_DONE", "dry-run: nothing was submitted")
        atomic_write_json(j / "result.json", {"dry_run": True, "at": store.now()})
        _receipt(d, job_id, ph, True)
        return {"ok": True, "status": "DRY_RUN_DONE", "dry_run": True}
    nxt = next_allowed(d, job_id, now)
    if nxt:
        return {"ok": False, "code": "company_cooldown", "error": "another application to this company was sent recently", "next_allowed_at": nxt.isoformat(timespec="seconds")}
    store.set_status(d, job_id, "SUBMITTING")
    m, phase = store.meta(d, job_id), "fill"
    ad = detect.adapter_for(m)
    try:
        fields = {f["fid"]: f for f in _json(j / "fields.json")}
        rows = check_plan(_json(j / "plan.json"), fields)
        with browser.session(d, ad.allowed_hosts(m)) as ctx:
            if prepare:
                prepare(ctx)
            page = ctx.new_page()
            page.goto(ad.apply_url(m), wait_until="load", timeout=45000)
            page.wait_for_selector(next(iter(fields.values()))["selector"], state="attached", timeout=15000)  # file inputs are often hidden
            if (b := ad.detect_blockers(page)):
                return _stop(d, job_id, "NEEDS_HUMAN", "needs_human", f"{b}: a person has to look at this page")
            rep = ad.fill(page, rows, fields, j)
            if rep["errors"] or rep["missing_on_page"]:
                return _stop(d, job_id, "FAILED", "plan_mismatch", "the form no longer matches the approved plan")
            phase = "click"
            (j / "screenshots").mkdir(exist_ok=True)
            ok = ad.submit(page, d, job_id)
            page.screenshot(path=str(j / "screenshots" / "submitted.png"), full_page=True)
    except Exception as e:  # noqa: BLE001
        if phase == "click":  # the button may have been pressed: never retry on our own
            return _stop(d, job_id, "NEEDS_HUMAN", "needs_human", f"may or may not have been submitted ({type(e).__name__}): check your email")
        return _stop(d, job_id, "FAILED", "failed", f"could not prepare the form ({type(e).__name__})")
    if not ok:
        return _stop(d, job_id, "NEEDS_HUMAN", "not_confirmed", "no confirmation page: it may or may not have been submitted, check your email")
    atomic_write_json(j / "result.json", {"submitted_at": store.now()})
    _receipt(d, job_id, ph, False)
    store.set_status(d, job_id, "SUBMITTED", "confirmed")
    return {"ok": True, "status": "SUBMITTED"}
