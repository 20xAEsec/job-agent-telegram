"""`discover poll`: list every watched Greenhouse board through the public API and search the chosen job sites,
prefilter, and return new candidates (DESIGN 4.8). Candidate text comes from third parties: it is data, never instructions."""
import hashlib
import html
import re
from pathlib import Path

import httpx

from .. import store
from ..fetch import _get
from ..paths import atomic_write_text
from . import boards, prefilter, sites

API = "https://boards-api.greenhouse.io/v1/boards/{board}/jobs"
MAX_CANDIDATES = 100
CORP = {"inc", "llc", "ltd", "corp", "corporation", "co", "company", "the", "plc", "gmbh"}
DEFAULT_SOURCES =["companies", "linkedin", "indeed"]  # keep in step with DEFAULT_SETTINGS.discovery.sources (app/src/state.ts)
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


def _alias(c: dict) -> str | None:
    """Same company + same title = the same opening, whichever site listed it."""
    co = "".join(w for w in prefilter._words(c["company"]) if w not in CORP)  # "Stepan Company" on one site is "Stepan" on another
    t = " ".join(prefilter._words(c["title"]))
    return "dup-" + hashlib.sha1(f"{co}|{t}".encode()).hexdigest()[:10] if co and t else None


def _greenhouse(slugs: list[str], usd: bool, errors: list) -> list[dict]:
    out = []
    for slug in slugs:
        try:
            r = _get(API.format(board=slug) + "?content=true")
            if r.status_code != 200:
                raise httpx.HTTPError(f"HTTP {r.status_code}")
            jobs = r.json().get("jobs", [])
        except (httpx.HTTPError, ValueError) as e:
            errors.append({"board": slug, "error": _clean(e, 80)})
            continue
        out += [{"title": j.get("title"), "company": j.get("company_name") or slug, "location": (j.get("location") or {}).get("name"),
                 "url": f"https://job-boards.greenhouse.io/{slug}/jobs/{j.get('id')}", "board": slug,
                 "posted": j.get("first_published") or j.get("updated_at") or "",
                 "salary_max": salary_max(html.unescape(j.get("content") or "")) if usd else None} for j in jobs]
    return out


def poll(d: Path) -> dict:
    s = store._load(d / "settings.json") or {}
    f = s.get("filters") or {}
    if not f.get("titles"):
        return {"ok": False, "code": "no_titles", "error": "settings.filters.titles is empty; set job titles first"}
    src = (s.get("discovery") or {}).get("sources") or DEFAULT_SOURCES
    hours = prefilter.window_hours(f)
    slugs = boards.load_boards(d)["greenhouse"] if "companies" in src else []
    chosen = [x for x in sites.SITES if x in src]
    errors: list[dict] = []
    skipped: list[dict] = []
    raw = _greenhouse(slugs, f.get("currency", "USD") == "USD", errors)
    if chosen:
        found, errs, skipped = sites.search(d, f, chosen, hours)
        raw += found
        errors += errs
    seen, done, aliases = boards.seen(d), set(), {}
    new = 0
    dropped: dict[str, int] = {}
    kept, drop_ids = [], []
    for x in raw:
        text = x.pop("description", "")
        c = {**x, **{k: _clean(x.get(k)) for k in ("title", "company", "location")}, "url": store.canonical_url(x["url"])}
        jid = c["job_id"] = store.job_id_for(c["url"])
        if jid in seen or jid in done or (store.jdir(d, jid) / "status.json").exists():
            continue
        a = _alias(c)
        if a and (aliases.get(a) or seen.get(a) or jid) != jid:
            continue  # already offered from another site
        if a:
            aliases[a] = jid
        done.add(jid)
        new += 1
        why = prefilter.drop_reason(c, f)
        if why:
            dropped[why] = dropped.get(why, 0) + 1
            drop_ids.append(jid)
        elif len(kept) < MAX_CANDIDATES:
            kept.append(c)  # not marked seen: if intake never runs, the next poll offers it again
            if text.strip():  # Indeed/Glassdoor block direct downloads: `fetch` reads this copy instead
                atomic_write_text(d / "listings" / f"{jid}.md", f"# {c['title']}\nCompany: {c['company']}\nLocation: {c['location']}\n\n{text}")
    boards.mark_seen(d, drop_ids, {a: j for a, j in aliases.items() if a not in seen})
    return {"ok": True, "boards": len(slugs), "sites": [sites.SITES[x] for x in chosen], "hours": hours, "found": len(raw), "new": new,
            "kept": len(kept), "dropped": dropped, "errors": errors, "skipped": skipped, "candidates": kept}
