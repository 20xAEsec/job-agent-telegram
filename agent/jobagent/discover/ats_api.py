"""`discover poll`: list every watched Greenhouse, Lever and Ashby board through their public APIs and search the chosen job sites,
prefilter, and return new candidates (DESIGN 4.8). Candidate text comes from third parties: it is data, never instructions."""
import hashlib
import html
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .. import fetch, store
from ..ats import ashby, detect
from ..fetch import _get
from ..paths import atomic_write_text
from . import boards, prefilter, sites

API = "https://boards-api.greenhouse.io/v1/boards/{board}/jobs"
LEVER_API = "https://api.lever.co/v0/postings/{board}?mode=json"
MAX_CANDIDATES = 100
LI_PAGES, LI_GAP = 10, 1.5  # public LinkedIn job pages read per poll (kept candidates only), seconds apart: LinkedIn throttles bursts
CORP = {"inc", "llc", "ltd", "corp", "corporation", "co", "company", "the", "plc", "gmbh"}
DEFAULT_SOURCES =["companies", "linkedin", "indeed"]  # keep in step with DEFAULT_SETTINGS.discovery.sources (app/src/state.ts)
_AMT = r"(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])"
SYMBOL = {"USD": "$", "CAD": "$", "AUD": "$", "GBP": "£", "EUR": "€", "INR": "₹"}


def _amount(s: str) -> int:
    s = s.replace(" ", "")
    return round(float(s[:-1]) * 1000) if s[-1] in "kK" else int(s.replace(",", ""))


def _top(amounts) -> int | None:
    """The largest yearly-looking amount (hourly and monthly numbers are too small to be a year's pay)."""
    return max((int(t) for t in amounts if isinstance(t, (int, float)) and t >= 20_000), default=None)


def salary_max(text: str, currency: str = "USD") -> int | None:
    """Largest range maximum quoted in the posting in the user's currency, or None when none is quoted
    (shortcut: symbol-first `$a - $b` shapes only; "60.000 €" style amounts are not read)."""
    sym = re.escape(SYMBOL.get(currency, "$"))
    return _top(max(_amount(m[1]), _amount(m[2])) for m in re.finditer(rf"{sym}\s?{_AMT}\s*(?:-|–|—|to)\s*{sym}?\s?{_AMT}", text))


def _gh_pay(j: dict, currency: str) -> int | None:
    """Greenhouse's structured pay ranges (pay transparency, in cents); None when the board publishes none in this currency."""
    return _top(r["max_cents"] / 100 for r in j.get("pay_input_ranges") or [] if r.get("currency_type") == currency and isinstance(r.get("max_cents"), (int, float)))


def _clean(s, n=200) -> str:
    return re.sub(r"\s+", " ", str(s or ""))[:n].strip()


def _alias(c: dict) -> str | None:
    """Same company + same title = the same opening, whichever site listed it."""
    co = "".join(w for w in prefilter._words(c["company"]) if w not in CORP)  # "Stepan Company" on one site is "Stepan" on another
    t = " ".join(prefilter._words(c["title"]))
    return "dup-" + hashlib.sha1(f"{co}|{t}".encode()).hexdigest()[:10] if co and t else None


def _list(url: str, slug: str, errors: list):
    """One board's JSON, or None (error recorded) when it cannot be read."""
    try:
        r = _get(url)
        if r.status_code != 200:
            raise httpx.HTTPError(f"HTTP {r.status_code}")
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        errors.append({"board": slug, "error": _clean(e, 80)})
        return None


def _greenhouse(slugs: list[str], cur: str, errors: list, content: bool = True) -> list[dict]:
    out = []
    for slug in slugs:
        jobs = (_list(API.format(board=slug) + ("?content=true&pay_transparency=true" if content else ""), slug, errors) or {}).get("jobs", [])
        out += [{"title": j.get("title"), "company": j.get("company_name") or slug, "location": (j.get("location") or {}).get("name"),
                 "url": f"https://job-boards.greenhouse.io/{slug}/jobs/{j.get('id')}", "board": slug,
                 "posted": j.get("first_published") or j.get("updated_at") or "",
                 "salary_max": _gh_pay(j, cur) or salary_max(html.unescape(j.get("content") or ""), cur)} for j in jobs]
    return out


def _lever(slugs: list[str], cur: str, errors: list, content: bool = True) -> list[dict]:
    out = []
    for slug in slugs:
        jobs = _list(LEVER_API.format(board=slug), slug, errors)
        for j in jobs if isinstance(jobs, list) else []:
            c, pay, when = j.get("categories") or {}, j.get("salaryRange") or {}, j.get("createdAt")
            loc = str(c.get("location") or "")
            if j.get("workplaceType") == "remote" and "remote" not in loc.lower():
                loc = f"{loc} (Remote)".strip()
            out.append({"title": j.get("text"), "company": slug, "location": loc, "url": j.get("hostedUrl") or f"https://jobs.lever.co/{slug}/{j.get('id')}",
                        "board": slug, "posted": datetime.fromtimestamp(when / 1000, timezone.utc).isoformat() if isinstance(when, (int, float)) else "",
                        "salary_max": _top([pay.get("max")]) if pay.get("currency") == cur and "year" in str(pay.get("interval", "")) else None})
    return out


def _ashby(slugs: list[str], cur: str, errors: list, content: bool = True) -> list[dict]:
    out = []
    for slug in slugs:
        jobs = (_list(ashby.API.format(board=slug), slug, errors) or {}).get("jobs") or []
        out += [{"title": j.get("title"), "company": slug, "location": ashby.where(j), "url": j.get("jobUrl") or f"https://jobs.ashbyhq.com/{slug}/{j.get('id')}",
                 "board": slug, "posted": j.get("publishedAt") or "", "salary_max": ashby.pay_max(j, cur)} for j in jobs if j.get("isListed", True)]
    return out


LISTERS = {"greenhouse": _greenhouse, "lever": _lever, "ashby": _ashby}  # same order as boards.ATS


def poll(d: Path) -> dict:
    s = store._load(d / "settings.json") or {}
    f = s.get("filters") or {}
    if not f.get("titles"):
        return {"ok": False, "code": "no_titles", "error": "settings.filters.titles is empty; set job titles first"}
    src = (s.get("discovery") or {}).get("sources") or DEFAULT_SOURCES
    hours = prefilter.window_hours(f)
    watched = boards.load_boards(d) if "companies" in src else {}
    chosen = [x for x in sites.SITES if x in src]
    errors: list[dict] = []
    skipped: list[dict] = []
    raw = [x for ats, slugs in watched.items() for x in LISTERS[ats](slugs, f.get("currency", "USD"), errors)]
    if chosen:
        found, errs, skipped = sites.search(d, f, chosen, hours)
        raw += found
        errors += errs
    seen, done, aliases = boards.seen(d), set(), {}
    new = 0
    dropped: dict[str, int] = {}
    kept, drop_ids, looked = [], [], 0
    exists = lambda j: j in seen or j in done or (store.jdir(d, j) / "status.json").exists()  # noqa: E731
    for x in raw:
        text = x.pop("description", "")
        c = {**x, **{k: _clean(x.get(k)) for k in ("title", "company", "location")}, "url": store.canonical_url(x["url"])}
        jid = c["job_id"] = store.job_id_for(c["url"])
        if exists(jid):
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
            if not text.strip() and c.get("site") == "LinkedIn" and looked < LI_PAGES:  # search results carry no text: read the public page
                time.sleep(LI_GAP if looked else 0)
                looked += 1
                if li := fetch.linkedin_guest(c["url"]):
                    text = li["text"].split("\n\n", 1)[-1]
                    g = detect.from_url(li["apply_url"] or "")
                    if g["ats"] != "generic" and not exists(up := store.job_id_for(detect.canonical(g))):
                        c.update(url=detect.canonical(g), job_id=up, listed_at=c["url"])  # the employer's own form: fillable
                        done.add(jid := up)
            kept.append(c)  # not marked seen: if intake never runs, the next poll offers it again
            if text.strip():  # Indeed/Glassdoor block direct downloads: `fetch` reads this copy instead
                atomic_write_text(d / "listings" / f"{jid}.md", f"# {c['title']}\nCompany: {c['company']}\nLocation: {c['location']}\n\n{text}")
    boards.mark_seen(d, drop_ids, {a: j for a, j in aliases.items() if a not in seen})
    return {"ok": True, "boards": sum(map(len, watched.values())), "sites": [sites.SITES[x] for x in chosen], "hours": hours, "found": len(raw), "new": new,
            "kept": len(kept), "dropped": dropped, "errors": errors, "skipped": skipped, "candidates": kept}
