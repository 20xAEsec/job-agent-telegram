"""data/screened.jsonl: jobs auto-search filtered out before a full read, with the plain-words reason (v3 S5). Written by `discover
poll` (stage "rules") and `llm accept screen` (stage "triage"); the app shows it on the Filtered out screen. Kept 30 days."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..paths import atomic_write_text, locked

KEEP_DAYS = 30


def append(d: Path, rows: list[dict], now: datetime | None = None) -> None:
    if not rows:
        return
    f = d / "screened.jsonl"
    now = now or datetime.now(timezone.utc)
    cut = (now - timedelta(days=KEEP_DAYS)).isoformat(timespec="seconds")
    with locked(f):
        try:
            old = f.read_text("utf-8").splitlines()
        except OSError:
            old = []
        keep = [ln for ln in old if ln.strip() and json.loads(ln).get("at", "") >= cut]
        new = [json.dumps({"at": now.isoformat(timespec="seconds"), **{k: r[k] for k in ("job_id", "title", "company", "url", "stage", "code", "reason") if k in r},
                           **({"score": r["score"]} if isinstance(r.get("score"), int) else {})}, ensure_ascii=False) for r in rows]
        atomic_write_text(f, "\n".join(keep + new) + "\n")


def trim(d: Path, now: datetime | None = None) -> int:
    """Drop rows older than KEEP_DAYS (jobagent maintain). Returns how many were removed."""
    f = d / "screened.jsonl"
    if not f.exists():
        return 0
    cut = ((now or datetime.now(timezone.utc)) - timedelta(days=KEEP_DAYS)).isoformat(timespec="seconds")
    with locked(f):
        old = [ln for ln in f.read_text("utf-8").splitlines() if ln.strip()]
        keep = [ln for ln in old if json.loads(ln).get("at", "") >= cut]
        if len(keep) != len(old):
            atomic_write_text(f, "\n".join(keep) + ("\n" if keep else ""))
    return len(old) - len(keep)
