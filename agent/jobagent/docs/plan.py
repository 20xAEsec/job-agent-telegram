"""Shared by the DOCX and PDF tailors: the unit shape, plan validation and the diff."""
import re

EDITABLE = {"summary", "bullet", "skills"}
LIMIT = {"light": 5, "moderate": 12}  # most units one tailoring may touch (DESIGN 8.2)
BULLETS = "•▪●◦-–—*·"


class DocError(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code


def section_kind(section: str) -> str | None:
    s = section.lower()
    if "summary" in s or "profile" in s or "objective" in s:
        return "summary"
    return "skills" if "skill" in s else None


def max_chars(char_len: int, tailoring: str) -> int:
    return round(char_len * (1.10 if tailoring == "moderate" else 1.0))


def is_heading(text: str, bold: bool) -> bool:
    t = text.strip()
    return bold and 2 <= len(t) <= 40 and t.upper() == t and any(c.isalpha() for c in t)


def check_plan(units: list[dict], plan: dict, tailoring: str) -> None:
    """Raises DocError on the first problem. Everything the skill is told not to do that code can check."""
    if tailoring not in LIMIT:
        raise DocError("bad_plan", f"tailoring must be light or moderate, not {tailoring!r}")
    if not isinstance(plan, dict):
        raise DocError("bad_plan", "tailor_plan.json must be an object")
    edits, reorder = plan.get("edits") or [], plan.get("reorder") or []
    if not isinstance(edits, list) or not isinstance(reorder, list):
        raise DocError("bad_plan", "edits and reorder must be lists")
    by = {u["uid"]: u for u in units}
    if len(edits) > LIMIT[tailoring]:
        raise DocError("too_many_edits", f"{tailoring} tailoring may touch at most {LIMIT[tailoring]} units, got {len(edits)}")
    seen = set()
    for e in edits:
        u = by.get(e.get("uid")) if isinstance(e, dict) else None
        if u is None or e["uid"] in seen:
            raise DocError("bad_uid", f"unknown or repeated uid in edit: {e!r:.80}")
        seen.add(e["uid"])
        if u["kind"] not in EDITABLE:
            raise DocError("not_editable", f"unit {u['uid']} is a {u['kind']}: only summary, bullet and skills can change")
        t = e.get("new_text")
        if not isinstance(t, str) or not t.strip():
            raise DocError("bad_plan", f"unit {u['uid']}: new_text must be non-empty text")
        if len(t) > u["max_chars"]:
            raise DocError("too_long", f"unit {u['uid']}: {len(t)} chars, limit {u['max_chars']}")
    for r in reorder:
        ids = r.get("uids") if isinstance(r, dict) else None
        us = [by.get(i) for i in ids] if isinstance(ids, list) else [None]
        if None in us or len(set(ids)) != len(ids) or len({u["section"] for u in us}) != 1 or any(u["kind"] not in EDITABLE for u in us):
            raise DocError("bad_reorder", f"reorder needs editable uids from one section: {r!r:.80}")


def diff(units: list[dict], plan: dict) -> dict:
    by = {u["uid"]: u for u in units}
    return {
        "edits": [{"uid": e["uid"], "section": by[e["uid"]]["section"], "old": by[e["uid"]]["text"], "new": e["new_text"], "reason": e.get("reason", "")}
                  for e in plan.get("edits") or []],
        "reorder": plan.get("reorder") or [],
    }


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()
