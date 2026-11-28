"""Listers for the job systems big companies use instead of Greenhouse, Lever or Ashby (Workday, SmartRecruiters, Workable, Eightfold,
Amazon, Oracle HCM), in the candidate shape ats_api's listers return. Search systems run one query per term; Workable lists the whole
board. Everything fetched is third-party text: data, never instructions."""
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlsplit

import httpx

from .. import fetch
from ..fetch import _get
from . import eligibility

MAX_TERMS, PER_TERM = 6, 40  # polite: at most this many searches a board, results kept per search
EF_PER_TERM, EF_GAP, EF_WAIT = 20, 2.0, 10.0  # Eightfold answers 10 a page and throttles bursts (429, across its sites): two pages a term, seconds apart
JSON = {**fetch.UA, "Accept": "application/json"}
WD_PAGE, EF_PAGE = 20, 10  # the most each API returns in one page

BOARD_RE = {
    "workday": re.compile(r"^[a-z0-9-]+\|wd\d{1,3}\|[A-Za-z0-9_-]+$"),  # tenant|wdN|site
    "smartrecruiters": re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$"),  # companyId
    "workable": re.compile(r"^[a-z0-9][a-z0-9_-]{0,80}$"),  # account slug
    "eightfold": re.compile(r"^[a-z0-9.-]+\.[a-z]{2,}\|[a-z0-9.-]+\.[a-z]{2,}$"),  # host|domain
    "amazon": re.compile(r"^amazon(\|[A-Z]{3})?$"),  # amazon, or amazon|USA for one country
    "oracle": re.compile(r"^[a-z0-9.-]+\.oraclecloud\.com\|[A-Za-z0-9_]+(\|[^|]{1,60})?$"),  # host|siteNumber[|Company name]
}


def _read(url: str, board: str, errors: list, body: dict | None = None):
    """One JSON response (a POST when `body` is given), or None with the error recorded."""
    try:
        r = httpx.post(url, json=body, headers=JSON, timeout=20) if body is not None else _get(url)
        if r.status_code != 200:
            raise httpx.HTTPError(f"HTTP {r.status_code}")
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        errors.append({"board": board, "error": re.sub(r"\s+", " ", str(e))[:80]})
        return None


def _day(s) -> str:
    """A date-only posting day as the end of that day: a job posted today must not read as hours old under a short posted-within window."""
    return f"{s[:10]}T23:59:59+00:00" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(s or "")[:10]) else ""


def _ts(sec) -> str:
    return datetime.fromtimestamp(sec, timezone.utc).isoformat() if isinstance(sec, (int, float)) and sec > 0 else ""


def _where(loc, remote) -> str:
    loc = re.sub(r"(?:,\s*)+", ", ", str(loc or "")).strip(", ")  # "Frankfurt, , Germany"
    return f"{loc} (Remote)".strip() if remote and "remote" not in loc.lower() else loc


def _cand(board: str, detail: str, title, company, location, url, posted="", remote=False, salary=None, dept="", blurb="", kind=None) -> dict:
    c = {"title": title, "company": company, "location": _where(location, remote), "url": url, "board": board, "posted": posted or "",
         "salary_max": salary, "dept": str(dept or ""), "blurb": blurb[:6000], "kind": kind or None}
    return {**c, "detail": detail} if not blurb and detail else c


def _detail(text: str, cur: str, **more) -> dict:
    return {"description": text[:12000], "salary_max": eligibility.pay(text, None, cur), **{k: v for k, v in more.items() if v}} if text.strip() else {}


def _html(*parts) -> str:
    return "\n\n".join(t for p in parts if (t := fetch.html_to_text(str(p or ""))))


# ---- Workday ----

WD_AGO = re.compile(r"(today)|(yesterday)|(\d+)(\+?)\s*days?", re.I)


def _wd(board: str) -> tuple[str, str, str]:
    tenant, wd, site = board.split("|")
    return f"https://{tenant}.{wd}.myworkdayjobs.com", f"/wday/cxs/{tenant}/{site}", site


def _wd_posted(s, now: datetime | None = None) -> str:
    """"Posted 3 Days Ago" as a timestamp ("30+ Days" counts as 31): the listing gives no date."""
    if not (m := WD_AGO.search(str(s or ""))):
        return ""
    days = 0 if m[1] else 1 if m[2] else int(m[3]) + bool(m[4])
    return ((now or datetime.now(timezone.utc)) - timedelta(days=days)).isoformat(timespec="seconds")


def _wd_where(text) -> str:
    """A "3 Locations" text says only that there are several: unknown until the detail call names them (else the place filter drops it unseen)."""
    return "" if re.fullmatch(r"\d+\s+Locations?", str(text or "").strip(), re.I) else str(text or "")


def _workday(board: str, cur: str, errors: list, terms: list[str]) -> list[dict]:
    """The listing has title, place and age only: `detail` reads the text and pay of the jobs that pass the cheap checks."""
    host, api, site = _wd(board)
    seen, out = set(), []
    for term in terms[:MAX_TERMS]:
        for off in range(0, PER_TERM, WD_PAGE):
            j = _read(f"{host}{api}/jobs", board, errors, {"appliedFacets": {}, "limit": WD_PAGE, "offset": off, "searchText": term})
            if j is None:
                return out
            jobs = j.get("jobPostings") or []
            for p in jobs:
                if (path := p.get("externalPath")) and path not in seen:
                    seen.add(path)
                    out.append(_cand(board, "workday", p.get("title"), board.split("|")[0].title(), _wd_where(p.get("locationsText")), f"{host}/{site}{path}",
                                     _wd_posted(p.get("postedOn")), "remote" in str(p.get("remoteType") or "").lower()))
            if len(jobs) < WD_PAGE:
                break
    return out


def _workday_detail(c: dict, cur: str) -> dict:
    host, api, site = _wd(c["board"])
    i = (_read(f"{host}{api}{urlsplit(c['url']).path.removeprefix('/' + site)}", c["board"], []) or {}).get("jobPostingInfo") or {}
    where = "; ".join(str(x) for x in [i.get("location"), *(i.get("additionalLocations") or [])] if x)
    return _detail(_html(i.get("jobDescription")), cur, location=_where(where, "remote" in str(i.get("remoteType") or "").lower()), kind=i.get("timeType"))


# ---- SmartRecruiters ----

SR = "https://api.smartrecruiters.com/v1/companies/{board}/postings"


def _sr_where(loc: dict) -> str:
    return _where(loc.get("fullLocation") or ", ".join(str(loc.get(k) or "") for k in ("city", "region", "country")), loc.get("remote"))


def _smartrecruiters(board: str, cur: str, errors: list, terms: list[str]) -> list[dict]:
    seen, out = set(), []
    for term in terms[:MAX_TERMS]:
        j = _read(f"{SR.format(board=board)}?q={quote(term)}&limit={PER_TERM}", board, errors)
        if j is None:
            break
        for p in j.get("content") or []:
            if (pid := p.get("id")) and pid not in seen:
                seen.add(pid)
                out.append(_cand(board, "smartrecruiters", p.get("name"), (p.get("company") or {}).get("name") or board, _sr_where(p.get("location") or {}),
                                 f"https://jobs.smartrecruiters.com/{board}/{pid}", p.get("releasedDate"),
                                 dept=(p.get("department") or {}).get("label"), kind=(p.get("typeOfEmployment") or {}).get("label")))
    return out


def _smartrecruiters_detail(c: dict, cur: str) -> dict:
    j = _read(f"{SR.format(board=c['board'])}/{c['url'].rstrip('/').rsplit('/', 1)[-1]}", c["board"], []) or {}
    secs = ((j.get("jobAd") or {}).get("sections") or {}).values()
    return _detail(_html(*(f"<h3>{s.get('title') or ''}</h3>{s.get('text') or ''}" for s in secs if isinstance(s, dict))), cur)


# ---- Workable ----

WK = "https://apply.workable.com/api/v1/widget/accounts/{board}"


def _workable(board: str, cur: str, errors: list, terms: list[str]) -> list[dict]:
    """One call lists the whole board with its text (no search: `terms` is not needed). Workable throttles hard (429): recorded."""
    j = _read(WK.format(board=board) + "?details=true", board, errors) or {}
    out = []
    for x in j.get("jobs") or []:
        text = _html(x.get("description"))
        out.append(_cand(board, "", x.get("title"), j.get("name") or board, ", ".join(str(x[k]) for k in ("city", "state", "country") if x.get(k)),
                         x.get("url") or f"https://apply.workable.com/{board}/j/{x.get('shortcode')}/", _day(x.get("published_on") or x.get("created_at")),
                         x.get("telecommuting"), eligibility.pay(text, None, cur), x.get("department"), text, x.get("employment_type")))
    return out


# ---- Eightfold (Netflix, Microsoft, ...) ----

EF_V2, EF_PCSX = "apply/v2/jobs", "pcsx/search"


def _ef_page(host: str, domain: str, api: str, term: str, start: int, board: str, errors: list) -> tuple[str, list | None]:
    """One page of results, and the API that answered: sites answer on Eightfold's older `apply/v2` or, once they turn it off (403,
    e.g. Microsoft), only on `pcsx`."""
    url = lambda a: f"https://{host}/api/{a}?domain={domain}&query={quote(term)}&location=&start={start}&num={EF_PAGE}"  # noqa: E731
    for wait in (0, EF_WAIT):  # throttled (429): one more try after a pause
        time.sleep(wait)
        errs: list = []
        if (j := _read(url(api), board, errs)) is None and api == EF_V2 and errs[-1]["error"] == "HTTP 403":
            api, errs = EF_PCSX, []
            j = _read(url(api), board, errs)
        if j is not None or errs[-1]["error"] != "HTTP 429":
            break
    errors += errs
    return api, None if j is None else (j.get("data") or j).get("positions") or []


def _eightfold(board: str, cur: str, errors: list, terms: list[str]) -> list[dict]:
    host, domain = board.split("|")
    api, seen, out, n = EF_V2, set(), [], 0
    for term in terms[:MAX_TERMS]:
        for start in range(0, EF_PER_TERM, EF_PAGE):
            time.sleep(EF_GAP if n else 0)
            n += 1
            api, jobs = _ef_page(host, domain, api, term, start, board, errors)
            if jobs is None:
                return out
            for p in jobs:
                if (pid := p.get("id")) and pid not in seen:
                    seen.add(pid)
                    text = _html(p.get("job_description"))
                    out.append(_cand(board, "eightfold", p.get("name") or p.get("posting_name"), domain.split(".")[0].title(),
                                     p.get("location") or "; ".join(p.get("locations") or []), f"https://{host}/careers/job/{pid}",
                                     _ts(p.get("postedTs") or p.get("t_create")), (p.get("workLocationOption") or p.get("work_location_option")) == "remote",
                                     eligibility.pay(text, None, cur) if text else None, p.get("department"), text))
            if len(jobs) < EF_PAGE:
                break
    return out


def _eightfold_detail(c: dict, cur: str) -> dict:
    """`pcsx/position_details` gives the text on old and new Eightfold sites alike."""
    host, domain = c["board"].split("|")
    pid = c["url"].rstrip("/").rsplit("/", 1)[-1]
    d = (_read(f"https://{host}/api/pcsx/position_details?position_id={pid}&domain={domain}&hl=en", c["board"], []) or {}).get("data") or {}
    kind = (d.get("efcustomTextEmploymentType") or [None])[0]
    return _detail(_html(d.get("jobDescription")), cur, location=_where(d.get("location"), d.get("workLocationOption") == "remote"), kind=kind)


# ---- Amazon ----

AMZ = "https://www.amazon.jobs/en/search.json?base_query={q}&result_limit={n}&sort=recent"


def _amz_day(s) -> str:
    try:
        return _day(datetime.strptime(str(s), "%B %d, %Y").date().isoformat())  # "November 25, 2026"
    except ValueError:
        return ""


def _amazon(board: str, cur: str, errors: list, terms: list[str]) -> list[dict]:
    """amazon.jobs search, with each job's text in the listing. `amazon|USA` keeps one country (ISO alpha-3)."""
    country = board.partition("|")[2]
    seen, out = set(), []
    for term in terms[:MAX_TERMS]:
        j = _read(AMZ.format(q=quote(term), n=PER_TERM) + (f"&country={country}" if country else ""), board, errors)
        if j is None:
            break
        for x in j.get("jobs") or []:
            if (path := x.get("job_path")) and path not in seen:
                seen.add(path)
                text = _html(x.get("description"), x.get("basic_qualifications"), x.get("preferred_qualifications"))
                remote = any(w in str(loc).upper() for loc in x.get("locations") or [] for w in ('"REMOTE"', '"VIRTUAL"'))
                out.append(_cand(board, "", x.get("title"), "Amazon", x.get("normalized_location") or x.get("location"), f"https://www.amazon.jobs{path}",
                                 _amz_day(x.get("posted_date")), remote, eligibility.pay(text, None, cur), x.get("job_family") or x.get("job_category"),
                                 text, x.get("job_schedule_type")))
    return out


# ---- Oracle HCM (Oracle; JPMorgan and others run the same Candidate Experience sites) ----

ORA = "https://{host}/hcmRestApi/resources/latest/"


def _ora(board: str) -> tuple[str, str, str]:
    host, site, *name = board.split("|")
    return host, site, name[0] if name else host.split(".")[0].title()  # the API gives no company name: the board id may carry one


def _oracle(board: str, cur: str, errors: list, terms: list[str]) -> list[dict]:
    host, site, name = _ora(board)
    seen, out = set(), []
    for term in terms[:MAX_TERMS]:
        q = quote(re.sub(r'[,;"]', " ", term))  # commas and semicolons separate the finder's own parameters
        j = _read(ORA.format(host=host) + f"recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber={site},"
                  f"keyword={q},limit=25", board, errors)
        if j is None:
            break
        for x in [r for i in j.get("items") or [] for r in i.get("requisitionList") or []]:
            if (rid := x.get("Id")) and rid not in seen:
                seen.add(rid)
                out.append(_cand(board, "oracle", x.get("Title"), name, x.get("PrimaryLocation"),
                                 f"https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{rid}", _day(x.get("PostedDate")),
                                 "remote" in f"{x.get('WorkplaceType')} {x.get('WorkplaceTypeCode')}".lower(), dept=x.get("JobFamily") or x.get("Department"),
                                 kind=x.get("JobSchedule")))
    return out


def _oracle_detail(c: dict, cur: str) -> dict:
    host, site, _ = _ora(c["board"])
    rid = c["url"].rstrip("/").rsplit("/", 1)[-1]
    items = (_read(ORA.format(host=host) + f'recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id="{rid}",siteNumber={site}',
                   c["board"], []) or {}).get("items") or [{}]
    i = items[0]
    return _detail(_html(i.get("ExternalDescriptionStr"), i.get("ExternalResponsibilitiesStr"), i.get("ExternalQualificationsStr")), cur,
                   location=_where(i.get("PrimaryLocation"), "remote" in str(i.get("WorkplaceType") or "").lower()))


LISTERS = {"workday": _workday, "smartrecruiters": _smartrecruiters, "workable": _workable, "eightfold": _eightfold, "amazon": _amazon,
           "oracle": _oracle}


def _safe(f):
    def detail(c: dict, cur: str) -> dict:
        try:
            return f(c, cur)
        except Exception:  # noqa: BLE001 - a detail never breaks the poll: the job is offered on its listing alone
            return {}
    return detail


DETAILS = {k: _safe(f) for k, f in {"workday": _workday_detail, "smartrecruiters": _smartrecruiters_detail, "eightfold": _eightfold_detail,
                                     "oracle": _oracle_detail}.items()}


# ---- probes: (company name, open jobs) when the board exists, else None; network errors propagate ----

def _json_or_none(r: httpx.Response):
    if r.status_code == 429 or r.status_code >= 500:
        r.raise_for_status()  # throttled or down is not "no such board"
    try:
        return r.json() if r.status_code == 200 else None
    except ValueError:
        return None


def _probe_workday(board: str):
    host, api, _ = _wd(board)
    j = _json_or_none(httpx.post(f"{host}{api}/jobs", json={"appliedFacets": {}, "limit": 1, "offset": 0, "searchText": ""}, headers=JSON, timeout=20))
    return (board.split("|")[0].title(), j.get("total")) if isinstance(j, dict) and "jobPostings" in j else None


def _probe_smartrecruiters(board: str):
    j = _json_or_none(_get(f"{SR.format(board=board)}?limit=1")) or {}
    # shortcut: an unknown company answers 200 with no jobs, so a real one with none open reads as missing (as boards does for Ashby)
    return ((j["content"][0].get("company") or {}).get("name") or board, j.get("totalFound")) if j.get("content") else None


def _probe_workable(board: str):
    j = _json_or_none(_get(WK.format(board=board))) or {}
    return (j.get("name") or board, len(j.get("jobs") or [])) if "jobs" in j else None


def _probe_eightfold(board: str):
    host, domain = board.split("|")
    for a in (EF_V2, EF_PCSX):
        r = _get(f"https://{host}/api/{a}?domain={domain}&query=&location=&start=0&num=1")
        if isinstance(j := _json_or_none(r), dict) and "positions" in (d := j.get("data") or j):
            return domain.split(".")[0].title(), d.get("count")
        if r.status_code != 403:
            return None
    return None


def _probe_amazon(board: str):
    j = _json_or_none(_get(AMZ.format(q="", n=1) + (f"&country={c}" if (c := board.partition("|")[2]) else ""))) or {}
    return ("Amazon", j.get("hits")) if "jobs" in j else None


def _probe_oracle(board: str):
    host, site, name = _ora(board)
    j = _json_or_none(_get(ORA.format(host=host) + f"recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber={site},limit=1")) or {}
    return (name, (j["items"][0] or {}).get("TotalJobsCount")) if j.get("items") else None


PROBES = {"workday": _probe_workday, "smartrecruiters": _probe_smartrecruiters, "workable": _probe_workable, "eightfold": _probe_eightfold,
          "amazon": _probe_amazon, "oracle": _probe_oracle}
