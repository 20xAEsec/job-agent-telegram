"""`fetch <id>` (posting.md, untrusted-wrapped) and `inspect <id>` (fields.json)."""
import json
import re
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
from playwright.sync_api import Error as PlaywrightError

from . import accounts, safety, store
from .ats import detect
from .ats.base import Closed, Unexpected
from .paths import atomic_write_json, atomic_write_text

MAX_CHARS = 30_000
DOWN = "I couldn't download the posting. The site may be down; try again later."  # shown on the job's card
UA = {"User-Agent": "Mozilla/5.0 (compatible; JobAgent; personal use)"}


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg"}
    BLOCK = {"p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "ul", "ol"}

    def __init__(self):
        super().__init__()
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        self.skip += tag in self.SKIP
        if tag in self.BLOCK:
            self.out.append("\n")
            if tag == "li":
                self.out.append("- ")

    def handle_endtag(self, tag):
        self.skip -= tag in self.SKIP and self.skip > 0
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def html_to_text(src: str) -> str:
    t = _Text()
    t.feed(src)
    return re.sub(r"\n\s*\n+", "\n\n", re.sub(r"[ \t]+", " ", "".join(t.out))).strip()


def _get(url: str) -> httpx.Response:
    err = None
    for i in range(3):
        try:
            r = httpx.get(url, headers=UA, follow_redirects=True, timeout=20)
            if r.status_code in (404, 410) or r.status_code < 500:
                return r
            err = httpx.HTTPStatusError("server error", request=r.request, response=r)
        except httpx.HTTPError as e:
            err = e
        time.sleep(2 ** i)
    raise err


INDEED_JOB = 'query { jobData(input: {jobKeys: [%s]}) { results { job { title sourceEmployerName location { formatted { long } } description { text } } } } }'


def _indeed(url: str) -> str | None:
    """An Indeed posting through Indeed's app API (the one auto-search uses): its web pages stop automated browsers with a bot check."""
    from jobspy.indeed.constant import headers

    u = urlsplit(url)
    jk = parse_qs(u.query).get("jk", [""])[0]
    if not re.fullmatch(r"[0-9a-f]{16}", jk):
        return None
    sub = (u.hostname or "").split(".")[0]
    co = {"www": "US", "uk": "GB"}.get(sub, sub.upper())
    try:
        r = httpx.post("https://apis.indeed.com/graphql", json={"query": INDEED_JOB % json.dumps(jk)}, timeout=20,
                       headers=headers | {"indeed-co": co, "indeed-locale": f"en-{co}"})
        j = r.json()["data"]["jobData"]["results"][0]["job"]
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return None  # the logged-in browser tries next
    loc = ((j.get("location") or {}).get("formatted") or {}).get("long", "")
    return f"# {j.get('title', '')}\nCompany: {j.get('sourceEmployerName', '')}\nLocation: {loc}\n\n{(j.get('description') or {}).get('text', '')}"


LI_GUEST = ("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}", "https://www.linkedin.com/jobs/view/{id}")


def parse_linkedin(src: str) -> dict | None:
    """A LinkedIn public job page: its text, and the employer's own apply link when the job is applied for off LinkedIn."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(src or "", "html.parser")
    desc = soup.find("div", class_="show-more-less-html__markup")
    if desc is None:
        return None
    t = lambda c: " ".join(x.get_text(" ", strip=True).split()) if (x := soup.find(class_=c)) else ""  # noqa: E731
    apply = None
    if (code := soup.find("code", id="applyUrl")) and code.contents:  # <code id="applyUrl"><!--"https://www.linkedin.com/jobs/view/externalApply/1?url=..."--></code>
        out = parse_qs(urlsplit(str(code.contents[0]).strip().strip('"')).query).get("url", [""])[0]
        apply = out if out.startswith("https://") else None
    info = {"title": t("top-card-layout__title"), "company": t("topcard__org-name-link") or t("topcard__flavor"), "location": t("topcard__flavor--bullet")}
    text = f"# {info['title']}\nCompany: {info['company']}\nLocation: {info['location']}\n\n{html_to_text(str(desc))}"
    return {**info, "text": text, "apply_url": apply}


def linkedin_guest(url: str) -> dict | None:
    """The public (logged-out) copy of a LinkedIn job: tried before the logged-in browser, so most links need no login."""
    from jobspy.linkedin.constant import headers

    m = re.search(r"/jobs/view/(?:[^/]*-)?(\d+)", url)
    if not m:
        return None
    for u in LI_GUEST:
        try:
            r = httpx.get(u.format(id=m[1]), headers=headers, follow_redirects=True, timeout=20)
        except httpx.HTTPError:
            continue
        if r.status_code == 200 and (got := parse_linkedin(r.text)):
            return got
    return None


def _closed(d: Path, job_id: str) -> dict:
    store.set_status(d, job_id, "CLOSED", "posting gone")
    return {"ok": False, "code": "closed", "error": "the posting is gone (404)"}


def fetch(d: Path, job_id: str) -> dict:
    m = store.meta(d, job_id)
    body = None
    listing = d / "listings" / f"{job_id}.md"  # text auto-search saved from a job site that blocks direct downloads
    try:
        if m.get("ats") == "generic" and listing.exists():
            body = listing.read_text("utf-8")
        elif m.get("ats") == "generic" and (site := accounts.site_for(m["url"])):
            body = _indeed(m["canonical_url"]) if site == "indeed" else None
            if site == "linkedin" and (li := linkedin_guest(m["canonical_url"])):
                body = li["text"]
                if li["apply_url"]:
                    store.update_meta(d, job_id, apply_url=li["apply_url"])  # `resolve` may turn it into a fillable job
            body = body or accounts.page_text(d, m["canonical_url"])  # else the logged-in JobAgent browser
        elif m.get("ats") == "generic":
            r = _get(m["url"])
            if r.status_code in (404, 410):
                return _closed(d, job_id)
            g = detect.from_url(str(r.url))  # redirected to the ATS, or a company page that embeds one
            g = g if g["ats"] != "generic" else detect.from_html(str(r.url), r.text)
            if g["ats"] != "generic":
                store.update_meta(d, job_id, **g)
                m = store.meta(d, job_id)
            else:
                body = html_to_text(r.text)
                if len(body) < 200:  # single-page app: render it
                    from . import browser

                    body = browser.page_text(d, m["url"], [r.url.host])
        if (ad := detect.adapter_for(m)):
            body = ad.posting_text(m)
            if body is None:  # not in the API listing: read the rendered posting page
                from . import browser

                body = browser.page_text(d, detect.canonical(m), ad.allowed_hosts(m))
    except Closed:
        return _closed(d, job_id)
    except accounts.NeedsLogin as e:
        name = accounts.SITES[e.site]["name"]
        store.update_meta(d, job_id, needs_login=e.site)  # the app offers a log-in button for this site
        store.set_status(d, job_id, "FAILED", f"{name} only shows this posting to people who are logged in. Log in under Settings, Job site logins, then tap Try again.")
        return {"ok": False, "code": "needs_login", "error": f"{name} asked for a login; the user must log in (Settings > Job site logins) and retry"}
    except PlaywrightError as e:
        store.set_status(d, job_id, "FAILED", DOWN)
        return {"ok": False, "code": "fetch_failed", "error": f"could not open the posting ({type(e).__name__}); retry later"}
    except httpx.HTTPError as e:
        store.set_status(d, job_id, "FAILED", DOWN)
        return {"ok": False, "code": "fetch_failed", "error": f"could not download the posting ({type(e).__name__}); retry later"}
    if not body or not body.strip():
        return {"ok": False, "code": "empty", "error": "the posting has no readable text"}
    if m.get("needs_login"):
        store.update_meta(d, job_id, needs_login=None)  # read fine this time
    atomic_write_text(store.jdir(d, job_id) / "posting.md", safety.untrusted(m["canonical_url"], body[:MAX_CHARS]))
    if store.status(d, job_id)["status"] == "NEW":
        store.set_status(d, job_id, "FETCHED")
    return {"ok": True, "job_id": job_id, "ats": m.get("ats"), "chars": min(len(body), MAX_CHARS)}


def inspect_job(d: Path, job_id: str, prepare=None) -> dict:
    """`prepare(context)` is a test hook for adapters that open the page (it serves saved fixtures)."""
    m = store.meta(d, job_id)
    ad = detect.adapter_for(m)
    if ad is None:
        return {"ok": False, "code": "no_adapter", "error": "only Greenhouse, Lever, Ashby, Breezy, Recruitee and Rippling forms can be filled; tell the user this job needs manual application"}
    try:
        fields = ad.inspect(m, d, prepare)
    except Closed:
        return _closed(d, job_id)
    except Unexpected as e:
        return {"ok": False, "code": "inspect_failed", "error": f"could not read the form ({str(e)[:80]})"}
    except (httpx.HTTPError, PlaywrightError) as e:
        return {"ok": False, "code": "inspect_failed", "error": f"could not read the form ({type(e).__name__})"}
    atomic_write_json(store.jdir(d, job_id) / "fields.json", fields)
    return {"ok": True, "adapter": ad.name, "fields": len(fields), "required": sum(f["required"] for f in fields)}
