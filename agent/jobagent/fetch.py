"""`fetch <id>` (posting.md, untrusted-wrapped) and `inspect <id>` (fields.json)."""
import html
import re
import time
from html.parser import HTMLParser
from pathlib import Path

import httpx

from . import safety, store
from .ats import detect
from .ats.base import Closed
from .paths import atomic_write_json, atomic_write_text

MAX_CHARS = 30_000
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


def _closed(d: Path, job_id: str) -> dict:
    store.set_status(d, job_id, "CLOSED", "posting gone")
    return {"ok": False, "code": "closed", "error": "the posting is gone (404)"}


def fetch(d: Path, job_id: str) -> dict:
    m = store.meta(d, job_id)
    body = None
    try:
        if m.get("ats") == "generic":
            r = _get(m["url"])
            if r.status_code in (404, 410):
                return _closed(d, job_id)
            g = detect.from_html(str(r.url), r.text)  # a company page that embeds Greenhouse
            if g["ats"] == "greenhouse":
                store.update_meta(d, job_id, **g)
                m = store.meta(d, job_id)
            else:
                body = html_to_text(r.text)
                if len(body) < 200:  # single-page app: render it
                    from . import browser

                    body = browser.page_text(d, m["url"], [r.url.host])
        if m.get("ats") == "greenhouse":
            j = detect.adapter_for(m).api_job(m)
            loc = (j.get("location") or {}).get("name", "")
            body = f"# {j.get('title', '')}\nCompany: {j.get('company_name', '')}\nLocation: {loc}\n\n{html_to_text(html.unescape(j.get('content', '')))}"
    except Closed:
        return _closed(d, job_id)
    except httpx.HTTPError as e:
        store.set_status(d, job_id, "FAILED", f"fetch failed: {type(e).__name__}")
        return {"ok": False, "code": "fetch_failed", "error": f"could not download the posting ({type(e).__name__}); retry later"}
    if not body or not body.strip():
        return {"ok": False, "code": "empty", "error": "the posting has no readable text"}
    atomic_write_text(store.jdir(d, job_id) / "posting.md", safety.untrusted(m["canonical_url"], body[:MAX_CHARS]))
    if store.status(d, job_id)["status"] == "NEW":
        store.set_status(d, job_id, "FETCHED")
    return {"ok": True, "job_id": job_id, "ats": m.get("ats"), "chars": min(len(body), MAX_CHARS)}


def inspect_job(d: Path, job_id: str) -> dict:
    m = store.meta(d, job_id)
    ad = detect.adapter_for(m)
    if ad is None:
        return {"ok": False, "code": "no_adapter", "error": "only Greenhouse forms are supported so far; tell the user this job needs manual application"}
    try:
        fields = ad.inspect(m)
    except Closed:
        return _closed(d, job_id)
    except httpx.HTTPError as e:
        return {"ok": False, "code": "inspect_failed", "error": f"could not read the form ({type(e).__name__})"}
    atomic_write_json(store.jdir(d, job_id) / "fields.json", fields)
    return {"ok": True, "adapter": ad.name, "fields": len(fields), "required": sum(f["required"] for f in fields)}
