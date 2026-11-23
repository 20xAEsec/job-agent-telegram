"""Job-site search for `discover poll`: LinkedIn, Indeed, Glassdoor and ZipRecruiter through python-jobspy.
None of them has a public jobs API; jobspy uses their guest/mobile endpoints. Results are third-party data, never instructions."""
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .. import store
from ..ats import detect
from ..paths import atomic_write_json

SITES = {"linkedin": "LinkedIn", "indeed": "Indeed", "glassdoor": "Glassdoor", "zip_recruiter": "ZipRecruiter"}
COUNTRY_BY_CURRENCY = {"USD": "usa", "GBP": "uk", "CAD": "canada", "AUD": "australia", "INR": "india"}
COUNTRY_NAME = {"usa": "United States", "uk": "United Kingdom"}
MAX_TITLES, MAX_PLACES = 3, 2  # up to 9 searches: 3 titles x (2 places + remote)
# Per site, each run: (searches, results per search, seconds between searches, minimum minutes between runs).
# One search = one page request: LinkedIn pages hold 10 jobs, ZipRecruiter 20, Indeed and Glassdoor 100.
# shortcut: limits from JobSpy's notes and our probes (LinkedIn refuses after ~10 pages in a burst from one IP); tune if a site still refuses.
LIMITS = {"linkedin": (4, 10, 8, 50), "zip_recruiter": (3, 20, 6, 50),  # 50, not 60: an hourly run can start a little early
          "glassdoor": (6, 30, 3, 30), "indeed": (9, 30, 1, 0)}
COOLDOWN_HOURS = 6  # a site that refused (429, "blocked") is left alone this long


def country(places: list[str], currency: str) -> str:
    """Indeed and Glassdoor search one country: the first location that names one, else a guess from the salary currency."""
    from jobspy.model import Country

    for p in places:
        try:
            return Country(p.split(",")[-1].strip().lower()).value
        except ValueError:
            pass
    return COUNTRY_BY_CURRENCY.get(currency, "usa")


def queries(f: dict) -> tuple[str, list[tuple[str, str, bool]]]:
    """(country, [(search term, location, remote)]) built only from settings.filters (never personal data)."""
    places = [p.strip() for p in f.get("locations", []) if p.strip() and "remote" not in p.lower()]
    c = country(places, f.get("currency", "USD"))
    mode = f.get("remote", "any")
    where = [] if mode == "remote_only" else places[:MAX_PLACES] or [COUNTRY_NAME.get(c, c.title())]
    out = []
    for t in [t.strip() for t in f.get("titles", []) if t.strip()][:MAX_TITLES]:
        out += [(t, w, False) for w in where]
        if mode != "onsite_only":
            out.append((f"{t} remote", COUNTRY_NAME.get(c, c.title()), True))
    return c, out


class _Errors(logging.Handler):
    def __init__(self):
        super().__init__(logging.ERROR)
        self.by_site: dict[str, str] = {}

    def emit(self, r):
        key = r.name.rsplit(".", 1)[-1].replace("_", "")  # jobspy.linkedin, jobspy.ziprecruiter
        site = next((v for k, v in SITES.items() if k.replace("_", "") == key), key)
        self.by_site.setdefault(site, re.sub(r"\s+", " ", r.getMessage())[:120])


def _cand(r: dict, currency: str) -> dict:
    val = lambda k: None if r.get(k) is None or r[k] != r[k] else r[k]  # noqa: E731 - pandas NaN != NaN
    url = str(val("job_url") or "")
    direct = str(val("job_url_direct") or "")
    if direct and detect.from_url(direct)["ats"] == "greenhouse":
        url = direct  # the employer's Greenhouse form: fillable
    loc = str(val("location") or "")
    if val("is_remote") and "remote" not in loc.lower():
        loc = f"{loc} (Remote)".strip()
    top = val("max_amount") or val("min_amount")
    return {"title": str(val("title") or ""), "company": str(val("company") or ""), "location": loc, "url": url,
            "site": SITES.get(str(val("site")), str(val("site"))), "posted": "",  # the site already applied the hours window; its dates are day-only
            "salary_max": int(top) if top and val("currency") == currency else None, "description": str(val("description") or "")}


def plan(site: str, n_queries: int, st: dict, now: datetime) -> tuple[int, int] | str:
    """(first query, how many) for this run, rotating so every query gets its turn; or why the site is skipped (plain words)."""
    n, _, _, gap = LIMITS[site]
    paused = st.get("paused_until")
    if paused and datetime.fromisoformat(paused) > now:
        return f"{SITES[site]} asked me to slow down; I'll search it again after {datetime.fromisoformat(paused).astimezone():%H:%M}"
    last = st.get("last_run")
    if last and now - datetime.fromisoformat(last) < timedelta(minutes=gap):
        return f"{SITES[site]} was searched less than {gap} minutes ago"
    return st.get("cursor", 0) % max(1, n_queries), min(n, n_queries)


def search(d: Path, f: dict, chosen: list[str], hours: int, now: datetime | None = None) -> tuple[list[dict], list[dict], list[dict]]:
    """The chosen sites in parallel, each within its LIMITS. Returns (candidates with a `description`, errors, skipped), all per site.
    data/sites.json keeps each site's rotation cursor, last run and pause."""
    from jobspy import scrape_jobs

    now = now or datetime.now(timezone.utc)
    c, qs = queries(f)
    state = store._load(d / "sites.json") or {}
    log, errs, skipped = logging.getLogger("jobspy"), _Errors(), []

    def run(site: str) -> list[dict]:
        p = plan(site, len(qs), state.get(site, {}), now)
        if isinstance(p, str):
            skipped.append({"site": SITES[site], "reason": p})
            return []
        start, n = p
        _, per, wait, _ = LIMITS[site]
        got, ran = [], 0
        for term, where, remote in (qs[start:] + qs[:start])[:n]:
            if ran:
                time.sleep(wait)
            try:
                df = scrape_jobs(site_name=[site], search_term=term, location=where, is_remote=remote, results_wanted=per,
                                 hours_old=max(1, hours), country_indeed=c, enforce_annual_salary=True, verbose=0)
            except Exception as e:  # noqa: BLE001 - one bad search must not stop the other sites
                errs.by_site.setdefault(SITES[site], type(e).__name__)
                break
            if SITES[site] in errs.by_site:
                break  # refused: stop now, asking again only deepens the block
            ran += 1
            got += [_cand(r, f.get("currency", "USD")) for r in df.to_dict("records")]
        refused = SITES[site] in errs.by_site
        state[site] = {"cursor": (start + ran) % max(1, len(qs)), "last_run": now.isoformat(),
                       **({"paused_until": (now + timedelta(hours=COOLDOWN_HOURS)).isoformat()} if refused else {})}
        return got

    log.addHandler(errs)
    try:
        with ThreadPoolExecutor(max(1, len(chosen))) as ex:  # different hosts: no reason to wait on each other
            out = [x for batch in ex.map(run, chosen) for x in batch]
    finally:
        log.removeHandler(errs)
    atomic_write_json(d / "sites.json", state)
    return [x for x in out if x["url"].startswith("http")], [{"site": s, "error": e} for s, e in errs.by_site.items()], skipped
