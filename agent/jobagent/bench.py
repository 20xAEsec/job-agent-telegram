"""jobagent bench screen: replay the v3 screening on an existing data folder (v3 S6). Code reads each job's meta.json, its listing in
listings/ and posting.md; no model does, except with --llm (the quick sort, through claude). Never writes into that folder and never
prints posting text: only counts per final status and per reason code."""
import json
import re
import shutil
import subprocess
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from . import llm
from .discover import eligibility, prefilter
from .paths import atomic_write_json

PROMPTS = Path(__file__).resolve().parents[2] / "prompts"


def _load(p: Path) -> dict:
    try:
        v = json.loads(p.read_text("utf-8"))
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _candidate(d: Path, j: Path) -> tuple[dict, str]:
    """What `discover poll` would have seen: the listing's header lines when there is one, else the posting's first heading."""
    meta, lst = _load(j / "meta.json"), d / "listings" / f"{j.name}.md"
    src = lst if lst.exists() else j / "posting.md"
    try:
        raw = src.read_text("utf-8")
    except OSError:
        raw = ""
    head = raw[:2000]
    grab = lambda k: (m[1].strip() if (m := re.search(rf"^{k}:[ \t]*(.*)$", head, re.M | re.I)) else "")  # noqa: E731
    title = m[1].strip() if (m := re.search(r"^#\s*(.+)$", head, re.M)) else ""
    c = {"job_id": j.name, "title": title, "company": grab("Company"), "location": grab("Location"), "url": str(meta.get("url") or ""),
         "board": meta.get("board"), "posted": "", "salary_max": None, "kind": None}
    return c, raw.split("\n\n", 1)[-1] if lst.exists() else raw


def _claude(name: str, stdin: str, model: str) -> dict | None:
    """One tool-less call, the same flags as app/src/llm.ts claudeArgs (json output instead of stream-json)."""
    args = ["claude", "-p", "--output-format", "json", "--model", model, "--tools", "", "--strict-mcp-config", "--safe-mode",
            "--system-prompt-file", str(PROMPTS / f"{name}.md"), "--json-schema", re.sub(r"\s+", " ", (PROMPTS / f"{name}.schema.json").read_text("utf-8")),
            "--no-session-persistence"]
    try:
        r = subprocess.run(args, input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=600)
        return json.loads(r.stdout).get("structured_output")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def screen(src: Path, use_llm: bool = False) -> dict:
    s = _load(src / "settings.json")
    f = s.get("filters") or {}
    users, now = eligibility.user_countries(f), datetime.now(timezone.utc)
    by: dict[str, Counter] = {}
    reasons: dict[str, Counter] = {"rules": Counter(), "triage": Counter()}
    kept: list[tuple[str, dict, str]] = []
    for j in sorted(p for p in (src / "jobs").glob("*") if p.is_dir()):
        status = str(_load(j / "status.json").get("status") or "?")
        b = by.setdefault(status, Counter(jobs=0, rules=0, triage=0, kept=0))
        b["jobs"] += 1
        c, text = _candidate(src, j)
        why = prefilter.drop_reason(c, f, now, title_ok=True)
        no = (why, "") if why else eligibility.rules(c, text, f, users)
        if no:
            b["rules"] += 1
            reasons["rules"][no[0]] += 1
        else:
            kept.append((status, c, text))
    triage = {"ran": False}
    if use_llm and kept:
        triage = _triage(src, s, kept, by, reasons["triage"])
    for st, c, _ in kept:
        by[st]["kept"] += 1
    by = {k: dict(v) for k, v in by.items()}
    for v in by.values():
        v["kept"] -= v["triage"]
    return {"ok": True, "jobs": sum(v["jobs"] for v in by.values()), "dropped_early": sum(v["rules"] + v["triage"] for v in by.values()),
            "by_status": by, "rules": dict(reasons["rules"]), "triage": dict(reasons["triage"]), "llm": triage}


def _triage(src: Path, s: dict, kept: list, by: dict, out: Counter) -> dict:
    """The quick sort on the jobs the rules kept, in a scratch copy (settings, profile, feedback): the source folder is never written."""
    tmp = Path(tempfile.mkdtemp(prefix="jobagent-bench-"))
    try:
        for n in ("settings.json", "profile.md", "feedback.jsonl"):
            if (src / n).exists():
                shutil.copy2(src / n, tmp / n)
        atomic_write_json(tmp / "run" / "poll.json", {"candidates": [{**{k: c.get(k) for k in ("job_id", "title", "company", "location", "salary_max", "url")},
                                                                      "tier": "exact", "excerpt": eligibility.excerpt(t)} for _, c, t in kept]})
        status = {c["job_id"]: st for st, c, _ in kept}
        ids, calls, failed = list(status), 0, 0
        for i in range(0, len(ids), llm.SCREEN_BATCH):
            batch = {"ids": ids[i:i + llm.SCREEN_BATCH]}
            ans = _claude("screen", Path(llm.build_input(tmp, "screen", None, batch)["file"]).read_text("utf-8"), "haiku")
            calls += 1
            if ans is None:
                failed += 1
                continue
            atomic_write_json(tmp / "run" / "screen.out.json", ans)
            r = llm.accept(tmp, "screen", None, str(tmp / "run" / "screen.out.json"), batch)
            if not r.get("ok"):
                failed += 1
                continue
            for x in r["scores"]:
                if x["score"] < r["bar"]:
                    by[status[x["id"]]]["triage"] += 1
                    out["below_bar"] += 1
        return {"ran": True, "calls": calls, "failed": failed}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
