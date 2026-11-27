"""The user's own decisions (data/feedback.jsonl, written by the app): a short, deterministic summary the analyst uses to calibrate scores."""
import json
import re
from collections import Counter
from pathlib import Path

BANDS = [("90+", 90, 101), ("80-89", 80, 90), ("70-79", 70, 80), ("60-69", 60, 70), ("under 60", 0, 60)]
YES, NO = {"approve", "apply_anyway", "applied_self"}, {"skip", "never"}
REASONS = {"pay", "location", "kind of work", "company", "level", "other"}  # v3 P2: tapped after Skip (decision "skip_reason")
STOP = {"and", "the", "of", "for", "to", "in", "a", "an", "with", "at", "on", "senior", "junior", "sr", "jr", "i", "ii", "iii"}


def _rows(d: Path, kinds: set[str] = YES | NO) -> list[dict]:
    try:
        lines = (d / "feedback.jsonl").read_text("utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and r.get("decision") in kinds:
            out.append(r)
    latest = {r.get("job_id"): r for r in out}  # a later decision on the same job replaces the earlier one
    return list(latest.values())


def _words(role: str) -> set[str]:
    return {w for w in re.findall(r"[a-z][a-z+#.]{1,20}", role.lower()) if w not in STOP}


def summary(d: Path) -> dict:
    rows = _rows(d)
    bands = []
    for name, lo, hi in BANDS:
        b = [r for r in rows if isinstance(r.get("score"), int) and lo <= r["score"] < hi]
        if b:
            bands.append({"band": name, "decisions": len(b), "approved": sum(r["decision"] in YES for r in b)})
    yes_w, no_w = Counter(), Counter()
    for r in rows:
        (yes_w if r["decision"] in YES else no_w).update(_words(str(r.get("role", ""))))
    skipped = [w for w, n in no_w.most_common(20) if n >= 2 and yes_w[w] == 0][:6]
    liked = [w for w, n in yes_w.most_common(20) if n >= 2 and no_w[w] == 0][:6]
    why = Counter(str(r.get("reason")) for r in _rows(d, {"skip_reason"}) if r.get("reason") in REASONS)
    return {"ok": True, "decisions": len(rows), "by_score": bands, "title_words_always_skipped": skipped, "title_words_always_approved": liked,
            "skip_reasons": dict(why.most_common()),
            "note": "The user's own past choices. A hint about taste, not a rule." if rows else "No decisions yet."}
