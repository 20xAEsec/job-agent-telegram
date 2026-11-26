"""`plan build <id>`: plan.json from the checked analysis, in code (in v2 a skill did this; it is a lookup table, not a judgment).
The user's own answers (answers.json, fid -> value) win over everything; then the classification decides. A skipped field must
be optional: a required field with no value comes back as `needs_answers` with its fids, and the app asks for them."""
import json
import re
from pathlib import Path

from . import fill, store
from .ats.base import match_option
from .llm import is_sensitive, question_for
from .paths import atomic_write_json

TRUE = re.compile(r"^(?:yes|y|true|1|checked|i agree|agree)$", re.I)


def _load(p: Path, default):
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def _row(f: dict, v, source: str) -> dict | None:
    t = f.get("type")
    if v is None or v == "" or v == []:
        return None
    if t == "checkbox":
        return {"fid": f["fid"], "action": "check", "value": v if isinstance(v, bool) else bool(TRUE.match(str(v).strip())), "source": source}
    if t in ("select", "multiselect"):
        vs = v if isinstance(v, list) else [x.strip() for x in str(v).split(",")] if t == "multiselect" else [v]
        if f.get("options"):
            vs = [match_option(f["options"], x) or x for x in vs]  # the page's own spelling; fill.check_plan refuses the rest
        return {"fid": f["fid"], "action": "select", "value": vs if t == "multiselect" else vs[0], "source": source}
    return {"fid": f["fid"], "action": "fill", "value": v if isinstance(v, str) else ", ".join(map(str, v)) if isinstance(v, list) else str(v), "source": source}


def _document(f: dict, j: Path) -> dict | None:
    if f.get("type") != "file":
        return None  # "type it in" alternatives to an upload stay empty
    name = "cover_letter.pdf" if re.search(r"cover", f"{f['fid']} {f.get('label', '')}", re.I) else "resume.pdf"
    return {"fid": f["fid"], "action": "upload", "value": name, "source": "document"} if (j / name).is_file() else None


def build(d: Path, job_id: str) -> dict:
    j = store.jdir(d, job_id)
    fields = _load(j / "fields.json", None)
    an = _load(j / "analysis.json", None)
    if not isinstance(fields, list) or not isinstance(an, dict):
        raise store.JobError("missing_file", "fields.json and analysis.json are needed: inspect and analyze first")
    cls = {c.get("fid"): c for c in an.get("field_classification") or [] if isinstance(c, dict)}
    mine = _load(j / "answers.json", {}) or {}
    draft = ((_load(d / "settings.json", {}) or {}).get("apply") or {}).get("draft_free_text", True)
    rows, missing, docs = [], [], []
    for f in fields:
        c = cls.get(f["fid"], {})
        k = c.get("class")
        if f["fid"] in mine:
            r = _row(f, mine[f["fid"]], "user")
        elif c.get("unusual"):
            r = None  # never filled unless the user answered it
        elif k == "document":
            r = _document(f, j)
            if r is None and f.get("required") and f.get("type") == "file":
                docs.append(f["fid"])
        elif k == "profile":
            r = _row(f, c.get("value"), "profile")
        elif k == "generated" and draft:
            r = _row(f, c.get("value"), "generated")
        else:
            r = None
        if r is None and f.get("required") and f["fid"] not in docs:
            missing.append(f["fid"])
        rows.append(r or {"fid": f["fid"], "action": "skip", "value": None, "source": "none"})
    if docs:
        return {"ok": False, "code": "missing_document", "fids": docs, "error": "a required file upload has no file to go in it"}
    if missing:
        byf, asked = {f["fid"]: f for f in fields}, {q.get("fid"): q for q in an.get("questions") or [] if isinstance(q, dict)}
        qs = [asked.get(fid) or question_for(byf[fid], None, bool(cls.get(fid, {}).get("sensitive")) or is_sensitive(byf[fid]), cls.get(fid, {}).get("save_key")) for fid in missing]
        return {"ok": False, "code": "needs_answers", "fids": missing, "questions": [{**q, "qid": f"q{i + 1}"} for i, q in enumerate(qs)],
                "error": "required fields have no value: ask the user"}
    plan = {"fields": rows}
    fill.check_plan(plan, {f["fid"]: f for f in fields})
    atomic_write_json(j / "plan.json", plan)
    return {"ok": True, "fields": len(rows), "filled": sum(r["action"] != "skip" for r in rows)}
