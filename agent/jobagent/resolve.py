"""`resolve <job_id>`: turn a job-site or company-page listing into the employer's own fillable posting (Greenhouse, Lever, Ashby).
Tries in order: the employer apply link the site gave (LinkedIn's public page), the employer page's redirect, ATS embed or single
Apply link, then the company's board on each supported ATS matched by title (and location). Keeps the job id, records `resolved_from`.
Writes only meta.json. Company, title and links come from third-party text: they only pick fixed ATS API URLs and are compared, never followed elsewhere."""
from pathlib import Path

import httpx

from . import accounts, fetch, store
from .ats import detect
from .discover import ats_api, boards, eligibility, prefilter

PLACE_NOISE = {"united", "states", "usa", "us", "remote", "hybrid", "onsite", "on", "site", "the", "of", "and"}


def _header(d: Path, job_id: str) -> dict:
    """title / company / location from the listing auto-search saved (its first lines are written by `discover poll`)."""
    try:
        head = (d / "listings" / f"{job_id}.md").read_text("utf-8").split("\n\n", 1)[0]
    except OSError:
        return {}
    out = {}
    for line in head.splitlines():
        if line.startswith("# "):
            out["title"] = line[2:].strip()
        elif ": " in line:
            k, v = line.split(": ", 1)
            out[k.strip().lower()] = v.strip()
    return out


def slugs_for(company: str) -> list[str]:
    """Board names a company is likely to use: "Acme Robotics, Inc." -> acmerobotics, acme-robotics."""
    w = [x for x in prefilter._words(company) if x not in ats_api.CORP]
    return [s for s in dict.fromkeys(["".join(w), "-".join(w)]) if s and boards.SLUG.match(s)]


def _near(a: str, b: str) -> bool:
    wa, wb = set(prefilter._words(a or "")), set(prefilter._words(b or ""))
    return bool((wa & wb) - PLACE_NOISE) or ("remote" in wa and "remote" in wb)


def match(cands: list[dict], title: str, location: str = "") -> dict | None:
    """The one posting with this title (exact words first, then a close match), narrowed by location; None when zero or ambiguous."""
    here = eligibility.places(location)
    # a posting that names only other countries is never this job, even when both say "remote"
    abroad = lambda there: bool(here and there) and eligibility.ALL not in here | there and not here & there  # noqa: E731
    same = [c for c in cands if prefilter.title_matches(c.get("title") or "", [title], "close")
            and not abroad(eligibility.places(c.get("location") or ""))]
    pool = [c for c in same if prefilter._words(c.get("title") or "") == prefilter._words(title)] or same
    if location and len(pool) > 1:
        pool = [c for c in pool if _near(c.get("location"), location)] or pool
    return pool[0] if len(pool) == 1 else None


def lookup(company: str, title: str, location: str = "", currency: str = "USD") -> tuple[dict, str] | None:
    for slug in slugs_for(company):
        for ats, lister in ats_api.LISTERS.items():
            if c := match(lister([slug], currency, [], content=False), title, location):
                return detect.from_url(c["url"]), f"{detect.ATS_NAMES[ats]} board {slug}"
    return None


def _employer_page(url: str) -> dict:
    try:
        r = fetch._get(url)
    except httpx.HTTPError:
        return {"ats": "generic"}
    if r.status_code != 200:
        return {"ats": "generic"}
    g = detect.from_url(str(r.url))
    g = g if g["ats"] != "generic" else detect.from_html(str(r.url), r.text)
    links = detect.postings_in(r.text)
    return g if g["ats"] != "generic" else links[0] if len(links) == 1 else {"ats": "generic"}


def resolve(d: Path, job_id: str) -> dict:
    m = store.meta(d, job_id)
    if m.get("ats", "generic") != "generic":
        return {"ok": True, "resolved": False, "ats": m["ats"], "reason": "already a fillable form"}
    an = store._load(store.jdir(d, job_id) / "analysis.json") or {}
    info = {**_header(d, job_id), **{k: str(an[a]) for k, a in (("company", "company"), ("title", "role"), ("location", "location")) if an.get(a)}}
    site, links = accounts.site_for(m["url"]), [m.get("apply_url")]
    if site == "linkedin" and not m.get("apply_url") and (li := fetch.linkedin_guest(m["canonical_url"])):
        links.append(li["apply_url"])
        info = {**{k: li[k] for k in ("title", "company", "location") if li[k]}, **info}
    hit, how = next(((g, "apply link") for u in links if u and (g := detect.from_url(u))["ats"] != "generic"), (None, ""))
    if hit is None and not site:  # a company page (job sites refuse automated downloads: skip them)
        g = _employer_page(m["url"])
        hit, how = (g, "employer page") if g["ats"] != "generic" else (None, "")
    if hit is None and info.get("company") and info.get("title"):
        cur = ((store._load(d / "settings.json") or {}).get("filters") or {}).get("currency", "USD")
        hit, how = lookup(info["company"], info["title"], info.get("location", ""), cur) or (None, "")
    if hit is None:
        return {"ok": True, "resolved": False, "reason": "no Greenhouse, Lever or Ashby posting found for this job"}
    cu = detect.canonical(hit)
    if (other := store.job_id_for(cu)) != job_id and (store.jdir(d, other) / "status.json").exists():
        return {"ok": True, "resolved": False, "duplicate_of": other, "reason": "the employer's posting is already in the job list"}
    store.update_meta(d, job_id, **hit, url=cu, canonical_url=cu, resolved_from=m["canonical_url"], resolved_how=how)
    return {"ok": True, "resolved": True, "ats": hit["ats"], "url": cu, "how": how}
