"""More job sources for `discover poll`: public JSON and RSS feeds that need no login and no key of the user's own: Himalayas, Jobicy,
Remote OK, We Work Remotely, Working Nomads, Dice, ClearanceJobs and Hacker News "Who is hiring?". Results are third-party data, never instructions."""
import re
import xml.etree.ElementTree as ET  # expat >= 2.4 (Python 3.12) refuses entity-expansion bombs
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote, urlencode

import httpx

from .. import store
from ..fetch import UA, _get, html_to_text
from ..paths import atomic_write_json

FEEDS = {"himalayas": "Himalayas", "jobicy": "Jobicy", "remoteok": "Remote OK", "wwr": "We Work Remotely", "workingnomads": "Working Nomads",
         "dice": "Dice", "clearancejobs": "ClearanceJobs", "hn": "Hacker News"}
GAP = {"hn": 360}  # minutes between runs of a feed (default 50): the HN thread is monthly
MAX_TERMS, COOLDOWN_HOURS, MAX_DESC = 6, 6, 12_000
US_ONLY = {"dice", "clearancejobs"}
DICE = "https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search"
DICE_KEY = "1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8"  # the public key dice.com's own search page sends; a 401/403 means it changed
DICE_FIELDS = "id|guid|summary|title|postedDate|jobLocation.displayName|detailsPageUrl|salary|companyName|employmentType|isRemote"
# Title words that say nothing about the field: the rest ("security", "detection") pick the jobs out of feeds that cannot search.
GENERIC = {"senior", "sr", "staff", "principal", "lead", "junior", "jr", "engineer", "engineering", "analyst", "manager", "specialist", "architect",
           "director", "head", "and", "the", "for", "remote", "ii", "iii", "iv", "associate", "consultant", "developer"}
HERE = ("usa", "u.s", "united states", "america", "anywhere", "worldwide", "global")
PER = {"hourly": 2080, "hour": 2080, "hr": 2080, "daily": 260, "day": 260, "weekly": 52, "week": 52, "monthly": 12, "month": 12}


class Refused(Exception):
    """403 or 429: the feed wants us to stop for a while."""


def _http(url: str, headers: dict | None = None, body: dict | None = None) -> httpx.Response:
    if body is not None:
        r = httpx.post(url, json=body, headers={**UA, **(headers or {})}, timeout=20)
    elif headers:
        r = httpx.get(url, headers={**UA, **headers}, follow_redirects=True, timeout=20)
    else:
        r = _get(url)
    if r.status_code in (401, 403, 429):
        raise Refused(f"HTTP {r.status_code}")
    r.raise_for_status()
    return r


def _when(v) -> datetime | None:
    try:
        if isinstance(v, (int, float)):
            d = datetime.fromtimestamp(v, timezone.utc)
        elif re.match(r"\d{4}-\d\d-\d\d", str(v)):
            d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        else:
            d = parsedate_to_datetime(str(v))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _yearly(top, period, cur: str, f: dict) -> int | None:
    try:
        top = float(top or 0)
    except (TypeError, ValueError):
        return None
    return int(top * PER.get(str(period or "").lower(), 1)) if top > 0 and cur == f.get("currency", "USD") else None


def _pay_text(s: str | None, f: dict) -> int | None:
    """'USD 120,000.00 - 160,000.00 per year', '$60 - $70 hourly'; Dice lists US jobs, so a bare number is dollars."""
    nums = [float(n.replace(",", "")) for n in re.findall(r"\d[\d,]*(?:\.\d+)?", s or "")]
    per = next((k for k in PER if re.search(rf"\b{k}\b", (s or "").lower())), None) or ("hourly" if nums and max(nums) < 500 else None)
    return _yearly(max(nums), per, "USD", f) if nums else None


def _abroad(where: str) -> bool:
    """True only when the feed says outright that the job is for elsewhere ("Canada Only", "Europe Only")."""
    w = where.lower()
    return "only" in w and not any(h in w for h in HERE) and not re.search(r"\bus\b", w)


def _cand(site: str, title, company, location, url, posted, salary_max=None, description="", kind=None, remote=False) -> dict:
    loc = str(location or "").strip()
    if remote and "remote" not in loc.lower():
        loc = f"{loc} (Remote)".strip()
    when = _when(posted)
    return {"title": str(title or "").strip(), "company": str(company or "").strip(), "location": loc, "url": str(url or ""), "site": FEEDS[site],
            "posted": when.isoformat() if when else "", "salary_max": salary_max, "description": html_to_text(str(description or ""))[:MAX_DESC],
            "kind": (", ".join(kind) if isinstance(kind, list) else str(kind or "")) or None}


def _hit(text: str, words: set[str]) -> bool:
    t = text.lower()
    return any(w in t for w in words)


def himalayas(terms, words, f, hours, us):
    out = []
    for t in terms:
        for x in _http(f"https://himalayas.app/jobs/api/search?q={quote(t)}" + ("&country=US" if us else "")).json().get("jobs", []):
            where = x.get("locationRestrictions") or []
            if us and where and _abroad(", ".join(where) + " only"):
                continue
            out.append(_cand("himalayas", x.get("title"), x.get("companyName"), ", ".join(where) or "Anywhere", x.get("guid") or x.get("applicationLink"),
                             x.get("pubDate"), _yearly(x.get("maxSalary") or x.get("minSalary"), x.get("salaryPeriod"), x.get("currency"), f),
                             x.get("description"), x.get("employmentType"), True))
    return out


def jobicy(terms, words, f, hours, us):
    # Jobicy has no text search (its `tag` ignores titles); its own cybersecurity industry list is the closest when the titles are about security.
    q = {"count": 100, **({"geo": "usa"} if us else {}), **({"industry": "security"} if _hit(" ".join(words), {"secur", "cyber"}) else {})}
    return [_cand("jobicy", x.get("jobTitle"), x.get("companyName"), x.get("jobGeo"), x.get("url"), x.get("pubDate"),
                  _yearly(x.get("annualSalaryMax") or x.get("annualSalaryMin"), None, x.get("salaryCurrency"), f), x.get("jobDescription"), x.get("jobType"), True)
            for x in _http("https://jobicy.com/api/v2/remote-jobs?" + urlencode(q)).json().get("jobs", []) if _hit(x.get("jobTitle") or "", words)]


def remoteok(terms, words, f, hours, us):
    return [_cand("remoteok", x.get("position"), x.get("company"), x.get("location"), x.get("url"), x.get("date"),
                  _yearly(x.get("salary_max") or x.get("salary_min"), None, "USD", f), x.get("description"), None, True)
            for x in _http("https://remoteok.com/api").json()[1:]  # item 0 is the terms of use
            if isinstance(x, dict) and _hit(x.get("position") or "", words) and not (us and _abroad(x.get("location") or ""))]


def wwr(terms, words, f, hours, us):
    out = []
    for it in ET.fromstring(_http("https://weworkremotely.com/remote-jobs.rss").content).iter("item"):
        g = lambda k: (it.findtext(k) or "").strip()  # noqa: E731
        company, _, title = g("title").partition(": ")
        if _hit(title, words) and not (us and _abroad(g("region"))):
            out.append(_cand("wwr", title or company, company if title else "", g("region"), g("link"), g("pubDate"), None, g("description"), g("type"), True))
    return out


def workingnomads(terms, words, f, hours, us):
    return [_cand("workingnomads", x.get("title"), x.get("company_name"), x.get("location"), x.get("url"), x.get("pub_date"), None, x.get("description"), None, True)
            for x in _http("https://www.workingnomads.com/api/exposed_jobs/").json() if _hit(x.get("title") or "", words)]


def dice(terms, words, f, hours, us):
    q = {"countryCode2": "US", "pageSize": 100, "fields": DICE_FIELDS}
    if hours <= 168:
        q["filters.postedDate"] = "ONE" if hours <= 24 else "THREE" if hours <= 72 else "SEVEN"
    if f.get("remote") == "remote_only":
        q["filters.workplaceTypes"] = "Remote"
    out = []
    for t in terms:
        for x in _http(f"{DICE}?{urlencode({**q, 'q': t})}", headers={"x-api-key": DICE_KEY}).json().get("data", []):
            out.append(_cand("dice", x.get("title"), x.get("companyName"), (x.get("jobLocation") or {}).get("displayName"), x.get("detailsPageUrl"),
                             x.get("postedDate"), _pay_text(x.get("salary"), f), x.get("summary"), x.get("employmentType"), x.get("isRemote")))
    return out


def clearancejobs(terms, words, f, hours, us):
    out = []
    for t in terms:
        body = {"keywords": t, "limit": 50, "sort": "date", **({} if f.get("remote") in ("any", "onsite_only") else {"remote": True})}
        for x in _http("https://api.clearancejobs.com/api/v1/jobs/search", body=body).json().get("data", []):
            locs = [str(l.get("location") or "") for l in x.get("locations") or []]
            place = next((l for l in locs if "remote" not in l.lower() and l != "Not provided"), "")
            desc = f"Clearance: {x.get('clearance') or 'not stated'}\n\n{x.get('preview_text') or ''}"
            out.append(_cand("clearancejobs", x.get("job_name"), x.get("company_name"), place, x.get("job_url"), x.get("created_at"),
                             _yearly(x.get("salary_max") or x.get("salary_min"), None, "USD", f), desc, None, any("remote" in l.lower() for l in locs)))
    return out


def hn(terms, words, f, hours, us):
    """The latest "Ask HN: Who is hiring?": each top-level comment is one company's post, first line "Company | Role | Location | ..."."""
    hits = _http("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10").json().get("hits", [])
    story = next((h["objectID"] for h in hits if str(h.get("title", "")).lower().startswith("ask hn: who is hiring")), None)
    if not story:
        return []
    out = []
    for c in _http(f"https://hn.algolia.com/api/v1/items/{story}").json().get("children", []):
        text = html_to_text(c.get("text") or "")
        parts = [p.strip() for p in text.split("\n", 1)[0].split("|")]
        parts = [p for p in parts if len(p) <= 100]  # a longer part is the post body run into the header line
        role = next((p for p in parts[1:] if _hit(p, words)), "")  # the header names the role: a word deeper in the post is not enough
        if not role:
            continue
        place = next((p for p in parts[1:] if re.search(r"remote|onsite|on-site|hybrid", p, re.I) or re.search(r", [A-Z]{2}\b|\b(US|USA|NYC|SF)\b", p)), "")
        out.append(_cand("hn", role, parts[0], place, f"https://news.ycombinator.com/item?id={c.get('id')}", c.get("created_at"),
                         None, text, None, "remote" in place.lower()))
    return out


READERS = {"himalayas": himalayas, "jobicy": jobicy, "remoteok": remoteok, "wwr": wwr, "workingnomads": workingnomads,
           "dice": dice, "clearancejobs": clearancejobs, "hn": hn}


def _skip(key: str, st: dict, now: datetime, us: bool) -> str | None:
    if key in US_ONLY and not us:
        return f"{FEEDS[key]} lists jobs in the United States only"
    paused = st.get("paused_until")
    if paused and datetime.fromisoformat(paused) > now:
        return f"{FEEDS[key]} asked me to slow down; I'll search it again after {datetime.fromisoformat(paused).astimezone():%H:%M}"
    gap, last = GAP.get(key, 50), st.get("last_run")  # 50, not 60: an hourly run can start a little early
    if last and now - datetime.fromisoformat(last) < timedelta(minutes=gap):
        return f"{FEEDS[key]} was searched less than {gap} minutes ago"
    return None


def search(d: Path, f: dict, chosen: list[str], hours: int, now: datetime | None = None) -> tuple[list[dict], list[dict], list[dict]]:
    """The chosen feeds in parallel. Returns (candidates with a `description`, errors, skipped), like sites.search.
    data/feeds.json keeps each feed's last run and pause. Search terms come only from settings.filters titles (never personal data)."""
    now = now or datetime.now(timezone.utc)
    terms = list(dict.fromkeys(t.strip() for t in (f.get("titles") or []) + (f.get("related_titles") or []) if t.strip()))[:MAX_TERMS]
    words = {w for t in terms for w in re.findall(r"[a-z0-9+#]+", t.lower()) if len(w) > 2 and w not in GENERIC} or {t.lower() for t in terms}
    us = str(f.get("country") or "United States").strip().lower() in {"united states", "united states of america", "usa", "us", "u.s."}
    since = now - timedelta(hours=hours)
    state = store._load(d / "feeds.json") or {}
    errs, skipped = [], []

    def run(key: str) -> list[dict]:
        why = _skip(key, state.get(key, {}), now, us)
        if why:
            skipped.append({"site": FEEDS[key], "reason": why})
            return []
        state[key] = {"last_run": now.isoformat()}
        try:
            got = READERS[key](terms, words, f, hours, us)
        except Exception as e:  # noqa: BLE001 - one bad feed must not stop the others
            errs.append({"site": FEEDS[key], "error": str(e)[:120] if isinstance(e, Refused) else type(e).__name__})
            if isinstance(e, Refused):
                state[key]["paused_until"] = (now + timedelta(hours=COOLDOWN_HOURS)).isoformat()
            return []
        return [c for c in got if c["url"].startswith("http") and c["title"] and (not c["posted"] or datetime.fromisoformat(c["posted"]) >= since)]

    if not terms:
        return [], [], []
    with ThreadPoolExecutor(max(1, len(chosen))) as ex:  # different hosts: no reason to wait on each other
        out = [x for batch in ex.map(run, [k for k in chosen if k in READERS]) for x in batch]
    atomic_write_json(d / "feeds.json", state)
    return list({c["url"]: c for c in out}.values()), errs, skipped
