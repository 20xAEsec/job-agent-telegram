"""jobagent maintain (v4 AP6): the daily upkeep, run by the app once a day (denied to Claude).
Rule 14: it deletes only what can be rebuilt or is no longer needed. It never touches a SUBMITTED or APPLIED_SELF job, a receipt,
approval.json, the profile, resumes or settings: only the statuses in PRUNE lose files, and only the file kinds in _prunable."""
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import store
from .discover import screened
from .paths import atomic_write_json

PRUNE = {"SKIPPED", "CLOSED", "FAILED", "DRY_RUN_DONE"}
EXPIRE = {"NEEDS_ANSWERS", "AWAITING_APPROVAL"}
SENT = {"SUBMITTED", "APPLIED_SELF", "SUBMITTING"}
PRUNE_DAYS, EXPIRE_DAYS = 30, 7
EXPIRED = "No answer in a week, so I closed it. Tap Apply anyway to bring it back."


def _older(at: str, days: int, now: datetime) -> bool:
    try:
        return datetime.fromisoformat(at) < now - timedelta(days=days)
    except (TypeError, ValueError):
        return False  # no date: keep


def _prunable(p: Path) -> bool:
    return p.is_file() and (p.name == "posting.md" or p.suffix.lower() in (".pdf", ".docx", ".png"))  # JSON (receipts, approvals) stays


def _prune(d: Path, jid: str) -> bool:
    j = store.jdir(d, jid)
    files, shots, listing = [p for p in j.iterdir() if _prunable(p)], j / "screenshots", d / "listings" / f"{jid}.md"
    if not files and not shots.exists() and not listing.exists():
        return False
    for p in files:
        p.unlink(missing_ok=True)
    shutil.rmtree(shots, ignore_errors=True)
    listing.unlink(missing_ok=True)
    return True


def run(d: Path, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    pruned, expired = 0, []
    for p in sorted((d / "jobs").glob("*/status.json")) if (d / "jobs").is_dir() else []:
        jid = p.parent.name
        try:
            st = store.status(d, jid)
            if st["status"] in EXPIRE and _older(st.get("updated_at", ""), EXPIRE_DAYS, now) and store.meta(d, jid).get("source") == "discovery":
                store.set_status(d, jid, "SKIPPED", EXPIRED)  # auto-search's only: a link the user sent waits for them
                expired.append(jid)
            elif (st["status"] in PRUNE and _older(st.get("updated_at", ""), PRUNE_DAYS, now)
                  and not any(h.get("status") in SENT for h in st.get("history", []))):  # SUBMITTED -> CLOSED still holds a receipt
                pruned += _prune(d, jid)
        except (store.JobError, OSError):
            continue  # one odd folder must not stop the upkeep
    out = {"at": now.isoformat(timespec="seconds"), "pruned": pruned, "expired": len(expired), "trimmed": screened.trim(d, now)}
    atomic_write_json(d / "upkeep.json", out)
    return {"ok": True, **out, "expired_ids": expired}
