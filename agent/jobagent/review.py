"""`review build <id>` -> review.json (the data behind the Telegram review card) and `review hash <id>`."""
import json
import re
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
    letter = ""
    if "cover_letter.pdf" in files:
        try:
            letter = (j / "cover_letter.md").read_text("utf-8").strip()[:1500]
        except OSError:
            pass
    rv = {
        "job_id": job_id, "plan_hash": ph, "ats": m.get("ats", "generic"), "dry_run": safety.dry_run_on(d),
        "company": _s(an.get("company"), 100), "role": _s(an.get("role"), 120), "location": _s(an.get("location"), 100), "salary": _s(an.get("salary"), 60),
        "score": m_.get("score") if isinstance(m_.get("score"), int) else None,
        "reasons": [_s(x, 160) for x in (m_.get("reasons") or [])[:3]], "dealbreakers": [_s(x, 160) for x in (m_.get("dealbreakers") or [])[:3]],
        "breakdown": _breakdown(m_), "must_haves": _must_haves(m_), "coverage": coverage(d, job_id, files),
        "answers": answers, "unusual": unusual, "generated_sensitive": gen_sens, "files": files,
        "resume": {"edits": len(diff.get("edits") or []), "reorders": len(diff.get("reorder") or []), "fallback": bool(diff.get("fallback")),
                   "verified": bool((diff.get("verify") or {}).get("ok", True))},
        "screenshots": ["screenshots/filled.png"] if shot.exists() else [], "url": m["canonical_url"],
        # what tailoring changed, so the user can judge it on the phone without opening the file
        "changes": [{"old": _s(e.get("old"), 200), "new": _s(e.get("new"), 200), "reason": _s(e.get("reason"), 140)} for e in (diff.get("edits") or [])[:12]],
        "cover_letter": letter, "previews": _previews(j, files),
    }
    atomic_write_json(j / "review.json", rv)
    return {"ok": True, "plan_hash": ph, "answers": len(answers), "unusual": unusual}


_NOISE = {"years", "year", "experience", "with", "and", "or", "of", "in", "the", "a", "an", "to", "for", "on", "strong", "solid", "knowledge",
          "skills", "skill", "ability", "proficiency", "proficient", "familiarity", "working", "understanding", "plus", "degree", "using", "tools"}


def _keys(req: str) -> list[str]:
    """The words that must appear for a requirement to count as covered: '3+ years of SQL and dbt' -> ['sql', 'dbt']."""
    return [w for w in re.findall(r"[a-z][a-z0-9+#./-]*", req.lower()) if w not in _NOISE and len(w) > 1][:4]


def _has(text: str, req: str) -> bool:
    ks = _keys(req)
    return bool(ks) and all(re.search(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])", text) for k in ks)


def coverage(d: Path, job_id: str, files: list | None = None) -> dict:
    """How many of the posting's must-haves the resume names, before and after tailoring. Deterministic word matching:
    shortcut: synonyms ("Postgres" for "PostgreSQL") count as missing; use the analyst's met/partial for meaning."""
    j = store.jdir(d, job_id)
    an = _read(j, "analysis.json", required=False) or {}
    reqs = [x["text"] for x in _must_haves(an.get("match") if isinstance(an.get("match"), dict) else {})]
    if not reqs:
        return {}
    try:
        before = (d / "resume_text.txt").read_text("utf-8").lower()
    except OSError:
        return {}
    pdf = next((j / f for f in (files or []) if f.startswith("resume") and f.endswith(".pdf")), j / "resume.pdf")
    after = before
    if pdf.is_file():
        try:
            import pymupdf

            with pymupdf.open(pdf) as doc:
                after = "\n".join(p.get_text() for p in doc).lower()
        except Exception:  # noqa: BLE001 - coverage is a nicety: never block the review
            pass
    pct = lambda t: round(100 * sum(_has(t, r) for r in reqs) / len(reqs))  # noqa: E731
    return {"before": pct(before), "after": pct(after), "missing": [r for r in reqs if not _has(after, r)][:6]}


def _breakdown(m_: dict) -> dict:
    b = m_.get("breakdown") if isinstance(m_.get("breakdown"), dict) else {}
    return {k: max(0, min(100, int(b[k]))) for k in ("title", "seniority", "skills", "location", "pay") if isinstance(b.get(k), (int, float))}


def _must_haves(m_: dict) -> list[dict]:
    xs = m_.get("must_haves") if isinstance(m_.get("must_haves"), list) else []
    return [{"text": _s(x.get("text"), 80), "status": x["status"]} for x in xs[:8]
            if isinstance(x, dict) and x.get("status") in ("met", "partial", "missing") and x.get("text")]


def _previews(j: Path, files: list) -> list[str]:
    """Page 1 of the uploaded resume as a picture (shown before the card), then the filled form. Not part of the plan hash."""
    out = []
    pdf = next((j / f for f in files if f.startswith("resume") and f.endswith(".pdf")), None)
    if pdf and pdf.is_file():
        try:
            from .docs import render

            (j / "screenshots").mkdir(exist_ok=True)
            (j / "screenshots" / "resume.png").write_bytes(render.page_png(pdf))
            out.append("screenshots/resume.png")
        except Exception:  # noqa: BLE001 - a preview must never block the review
            pass
    if (j / "screenshots" / "filled.png").exists():
        out.append("screenshots/filled.png")
    return out


def hash_(d: Path, job_id: str) -> dict:
    try:
        return {"ok": True, "plan_hash": safety.plan_hash(store.jdir(d, job_id))}
    except safety.SafetyError as e:
        return {"ok": False, "code": e.code, "error": str(e)}
