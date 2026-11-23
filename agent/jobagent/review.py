"""`review build <id>` -> review.json (the data behind the Telegram review card) and `review hash <id>`."""
import json
from pathlib import Path

from . import safety, store
from .paths import atomic_write_json


def _read(j: Path, name: str, required=True):
    try:
        return json.loads((j / name).read_text("utf-8"))
    except (OSError, ValueError):
        if required:
            raise store.JobError("missing_file", f"{name} is missing or not valid JSON") from None
        return None


def _s(v, n=200) -> str:
    t = ", ".join(map(str, v)) if isinstance(v, list) else str(v if v is not None else "")
    return " ".join(t.split())[:n]


def build(d: Path, job_id: str) -> dict:
    j, m = store.jdir(d, job_id), store.meta(d, job_id)
    if store.status(d, job_id)["status"] != "FILLED_DRY":
        raise store.JobError("bad_status", "review build needs a job in status FILLED_DRY (run fill --dry-run first)")
    plan, fields, an = _read(j, "plan.json"), {f["fid"]: f for f in _read(j, "fields.json")}, _read(j, "analysis.json")
    ph, rep = safety.plan_hash(j), _read(j, "fill_report.json")
    if rep.get("plan_hash") != ph or rep.get("blocker"):
        raise store.JobError("stale_fill", "plan.json changed since the last dry fill: run fill --dry-run again")
    if not isinstance(an, dict):
        raise store.JobError("bad_analysis", "analysis.json must be an object")
    cls = {c.get("fid"): c for c in an.get("field_classification") or [] if isinstance(c, dict)}
    answers, unusual, gen_sens, files = [], [], [], []
    for r in plan["fields"]:
        if r["action"] == "skip":
            continue
        f, c = fields[r["fid"]], cls.get(r["fid"], {})
        sens = bool(c.get("sensitive")) or f["section"] in ("compliance", "demographic")
        answers.append({"fid": r["fid"], "label": _s(f["label"], 120), "value": _s(r.get("value"), 300), "source": r.get("source", "profile"),
                        "sensitive": sens, "required": f["required"]})
        if c.get("unusual") or safety.UNUSUAL.search(f["label"]):
            unusual.append(r["fid"])
        if r.get("source") == "generated" and sens and f["required"]:
            gen_sens.append(r["fid"])
        if r["action"] == "upload":
            files.append(r["value"])
    diff = _read(j, "diff.json", required=False) or {}
    m_ = an.get("match") if isinstance(an.get("match"), dict) else {}
    shot = j / "screenshots" / "filled.png"
    rv = {
        "job_id": job_id, "plan_hash": ph, "ats": m.get("ats", "generic"), "dry_run": safety.dry_run_on(d),
        "company": _s(an.get("company"), 100), "role": _s(an.get("role"), 120), "location": _s(an.get("location"), 100), "salary": _s(an.get("salary"), 60),
        "score": m_.get("score") if isinstance(m_.get("score"), int) else None,
        "reasons": [_s(x, 160) for x in (m_.get("reasons") or [])[:3]], "dealbreakers": [_s(x, 160) for x in (m_.get("dealbreakers") or [])[:3]],
        "answers": answers, "unusual": unusual, "generated_sensitive": gen_sens, "files": files,
        "resume": {"edits": len(diff.get("edits") or []), "reorders": len(diff.get("reorder") or []), "fallback": bool(diff.get("fallback")),
                   "verified": bool((diff.get("verify") or {}).get("ok", True))},
        "screenshots": ["screenshots/filled.png"] if shot.exists() else [], "url": m["canonical_url"],
    }
    atomic_write_json(j / "review.json", rv)
    return {"ok": True, "plan_hash": ph, "answers": len(answers), "unusual": unusual}


def hash_(d: Path, job_id: str) -> dict:
    try:
        return {"ok": True, "plan_hash": safety.plan_hash(store.jdir(d, job_id))}
    except safety.SafetyError as e:
        return {"ok": False, "code": e.code, "error": str(e)}
