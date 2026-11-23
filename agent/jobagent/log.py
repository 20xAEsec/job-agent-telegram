"""applications.csv: one row per job (DESIGN 6.5). Company, role and URL only: no personal data."""
import csv
import os
from datetime import date
from pathlib import Path

from . import store

COLS = ["job_id", "date", "company", "role", "url", "ats", "source", "status", "match_score", "outcome", "updated_at"]
OUTCOMES = {"", "interview", "rejected", "offer", "ghosted"}


def _safe(v) -> str:
    """Spreadsheet formulas from a posting must stay text when the CSV is opened in Excel."""
    s = " ".join(str(v or "").split())[:200]
    return "'" + s if s[:1] in "=+-@" else s


def _rows(d: Path) -> list[dict]:
    try:
        with open(d / "applications.csv", newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))
    except OSError:
        return []


def _write(d: Path, rows: list[dict]) -> None:
    p = d / "applications.csv"
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, COLS)
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, p)


def upsert(d: Path, job_id: str) -> dict:
    x = store.summary(d, job_id)
    rows = _rows(d)
    old = next((r for r in rows if r["job_id"] == job_id), {})
    row = {"job_id": job_id, "date": old.get("date") or date.today().isoformat(), "company": _safe(x["company"]), "role": _safe(x["role"]),
           "url": _safe(x["url"]), "ats": x["ats"], "source": x["source"], "status": x["status"],
           "match_score": "" if x["score"] is None else x["score"], "outcome": old.get("outcome", ""), "updated_at": x["updated_at"]}
    _write(d, [r for r in rows if r["job_id"] != job_id] + [row])
    return {"ok": True, "job_id": job_id}


def outcome(d: Path, job_id: str, value: str) -> dict:
    if value not in OUTCOMES:
        raise store.JobError("bad_outcome", "outcome must be interview, rejected, offer, ghosted or empty")
    rows = _rows(d)
    hit = [r for r in rows if r["job_id"] == job_id]
    if not hit:
        raise store.JobError("no_row", "that job has no history row yet")
    hit[0]["outcome"] = value
    _write(d, rows)
    return {"ok": True}


def export(d: Path) -> dict:
    """Newest first. The file at `path` is the user's CSV."""
    if not (d / "applications.csv").exists():
        _write(d, [])
    return {"ok": True, "path": str((d / "applications.csv").resolve()), "rows": sorted(_rows(d), key=lambda r: r["updated_at"], reverse=True)}
