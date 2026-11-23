"""`discover poll`: list every Greenhouse board through the public API, prefilter, and return new candidates (DESIGN 4.8).
Candidate text comes from third parties: it is data, never instructions."""
import html
import re
from pathlib import Path

import httpx

from .. import store
from ..fetch import _get
from . import boards, prefilter

API = "https://boards-api.greenhouse.io/v1/boards/{board}/jobs"
MAX_CANDIDATES = 100
_AMT = r"(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])"
RANGE = re.compile(rf"\$\s?{_AMT}\s*(?:-|–|—|to)\s*\$?\s?{_AMT}")


def _amount(s: str) -> int:
    s = s.replace(" ", "")
    return round(float(s[:-1]) * 1000) if s[-1] in "kK" else int(s.replace(",", ""))


def salary_max(text: str) -> int | None:
    """Largest USD range maximum quoted in the posting, or None when none is quoted (shortcut: USD, `$a - $b` shapes only)."""
    tops = [max(_amount(m[1]), _amount(m[2])) for m in RANGE.finditer(text)]
    return max((t for t in tops if t >= 20_000), default=None)


def _clean(s, n=200) -> str:
    return re.sub(r"\s+", " ", str(s or ""))[:n].strip()


def poll(d: Path) -> dict:
    f = (store._load(d / "settings.json") or {}).get("filters") or {}
    if not f.get("titles"):
        return {"ok": False, "code": "no_titles", "error": "settings.filters.titles is empty; set job titles first"}
    usd = f.get("currency", "USD") == "USD"
    seen, done = boards.seen(d), set()
    found = new = 0
    dropped: dict[str, int] = {}
    errors, kept, drop_ids = [], [], []
    slugs = boards.load_boards(d)["greenhouse"]
    for slug in slugs:
        try:
            r = _get(API.format(board=slug) + "?content=true")
            if r.status_code != 200:
                raise httpx.HTTPError(f"HTTP {r.status_code}")
            jobs = r.json().get("jobs", [])
        except (httpx.HTTPError, ValueError) as e:
            errors.append({"board": slug, "error": _clean(e, 80)})
            continue
        for j in jobs:
            found += 1
            canon = f"https://job-boards.greenhouse.io/{slug}/jobs/{j.get('id')}"
            jid = store.job_id_for(canon)
            if jid in seen or jid in done or (store.jdir(d, jid) / "status.json").exists():
                continue
            done.add(jid)
            new += 1
            c = {"job_id": jid, "title": _clean(j.get("title")), "company": _clean(j.get("company_name") or slug),
                 "location": _clean((j.get("location") or {}).get("name")), "url": canon, "board": slug,
                 "posted": j.get("first_published") or j.get("updated_at") or "",
                 "salary_max": salary_max(html.unescape(j.get("content") or "")) if usd else None}
            why = prefilter.drop_reason(c, f)
            if why:
                dropped[why] = dropped.get(why, 0) + 1
                drop_ids.append(jid)
            elif len(kept) < MAX_CANDIDATES:
                kept.append(c)  # not marked seen: if intake never runs, the next poll offers it again
    boards.mark_seen(d, drop_ids)
    return {"ok": True, "boards": len(slugs), "found": found, "new": new, "kept": len(kept), "dropped": dropped, "errors": errors, "candidates": kept}
