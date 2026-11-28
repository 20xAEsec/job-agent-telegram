"""`resolve`: job-site and company-page listings upgraded to the employer's fillable posting; LinkedIn's public page before any login.
No network: HTTP and the LinkedIn page are faked from fixtures."""
import json

import httpx
import pytest

from jobagent import accounts, cli, fetch, resolve, store
from jobagent.discover import ats_api
from test_jobs import FX

LI = "https://www.linkedin.com/jobs/view/4012345678"
LV = "https://jobs.lever.co/acme/2f3c9a1e-5b6d-4c7e-8f90-1a2b3c4d5e6f"
GUEST = (FX / "linkedin_guest.html").read_text("utf-8")


def resp(url, status=200, body=None, text=None):
    if text is not None:
        return httpx.Response(status, text=text, request=httpx.Request("GET", url))
    return httpx.Response(status, json=body if body is not None else {}, request=httpx.Request("GET", url))


def test_parse_linkedin_public_page():
    li = fetch.parse_linkedin(GUEST)
    assert (li["title"], li["company"], li["location"]) == ("Data Analyst", "Acme", "Austin, TX")
    assert li["apply_url"] == f"{LV}?lever-source=LinkedIn" and "- SQL" in li["text"]
    assert fetch.parse_linkedin("<html>Sign in to see this job</html>") is None


def test_linkedin_link_uses_the_public_page_before_login(tmp_path, monkeypatch):
    monkeypatch.setattr(httpx, "get", lambda url, **kw: resp(url, text=GUEST) if "jobs-guest" in url else pytest.fail(f"unexpected {url}"))
    monkeypatch.setattr(accounts, "page_text", lambda *a: pytest.fail("must not need the logged-in browser"))
    jid = store.new_job(tmp_path, LI)["job_id"]
    assert fetch.fetch(tmp_path, jid)["ok"]
    assert "We need a Data Analyst." in (store.jdir(tmp_path, jid) / "posting.md").read_text("utf-8")
    assert store.meta(tmp_path, jid)["apply_url"] == f"{LV}?lever-source=LinkedIn"


def test_needs_login_is_recorded_for_the_app(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch, "linkedin_guest", lambda u: None)

    def wall(d, url):
        raise accounts.NeedsLogin("linkedin")
    monkeypatch.setattr(accounts, "page_text", wall)
    jid = store.new_job(tmp_path, LI)["job_id"]
    assert fetch.fetch(tmp_path, jid)["code"] == "needs_login"
    assert store.meta(tmp_path, jid)["needs_login"] == "linkedin" and store.status(tmp_path, jid)["status"] == "FAILED"


def test_resolve_linkedin_to_the_employer_lever_form(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(fetch, "linkedin_guest", lambda u: fetch.parse_linkedin(GUEST))
    jid = store.new_job(tmp_path, LI)["job_id"]
    assert cli.main(["--data-dir", str(tmp_path), "resolve", jid]) == 0
    assert json.loads(capsys.readouterr().out) == {"ok": True, "resolved": True, "ats": "lever", "url": LV, "how": "apply link"}
    m = store.meta(tmp_path, jid)
    assert (m["job_id"], m["ats"], m["board"], m["url"], m["resolved_from"]) == (jid, "lever", "acme", LV, LI)  # same job id, new form
    assert resolve.resolve(tmp_path, jid)["reason"] == "already a fillable form"


def test_resolve_by_company_board_and_title(tmp_path, monkeypatch):
    """An Indeed listing (company + title from the saved listing) found on the company's Greenhouse board."""
    jobs = {"jobs": [{"id": 7, "title": "Data Analyst", "location": {"name": "Austin, TX"}}, {"id": 8, "title": "Data Analyst", "location": {"name": "Berlin"}},
                     {"id": 9, "title": "Senior Data Analyst", "location": {"name": "Austin, TX"}}]}
    asked = []

    def get(url):
        asked.append(url)
        return resp(url, 200, jobs) if "boards/acme-robotics/" in url else resp(url, 404)
    monkeypatch.setattr(ats_api, "_get", get)
    jid = store.new_job(tmp_path, "https://www.indeed.com/viewjob?jk=0123456789abcdef")["job_id"]
    (tmp_path / "listings").mkdir()
    (tmp_path / "listings" / f"{jid}.md").write_text("# Data Analyst\nCompany: Acme Robotics, Inc.\nLocation: Austin, TX\n\nText.", "utf-8")
    r = resolve.resolve(tmp_path, jid)
    assert r == {"ok": True, "resolved": True, "ats": "greenhouse", "url": "https://job-boards.greenhouse.io/acme-robotics/jobs/7", "how": "Greenhouse board acme-robotics"}
    assert not any("indeed.com" in u for u in asked)  # job sites are never downloaded here
    assert store.job_id_for(store.meta(tmp_path, jid)["canonical_url"]) != jid  # the id stays; only the form moved


def test_match_is_conservative():
    c = lambda t, loc: {"title": t, "location": loc}  # noqa: E731
    assert resolve.match([c("Data Analyst", "Austin"), c("Data Analyst", "Berlin")], "Data Analyst") is None  # ambiguous: no guess
    assert resolve.match([c("Data Analyst", "Austin"), c("Data Analyst", "Berlin")], "Data Analyst", "Berlin, Germany")["location"] == "Berlin"
    assert resolve.match([c("Chef", "Austin")], "Data Analyst") is None
    us, mx = c("Data Analyst", "Remote - US: Select locations"), c("Data Analyst", "Remote - Mexico")
    assert resolve.match([mx, us], "Data Analyst", "Remote, USA") == us
    assert resolve.match([mx], "Data Analyst", "Remote, USA") is None  # the only posting is for another country
    assert resolve.slugs_for("Acme Robotics, Inc.") == ["acmerobotics", "acme-robotics"] and resolve.slugs_for("The Co") == []


def test_resolve_company_page_apply_link_and_duplicates(tmp_path, monkeypatch):
    page = f'<html><body><h1>Data Analyst</h1><a class="btn" href="{LV}/apply">Apply now</a></body></html>'
    monkeypatch.setattr(fetch, "_get", lambda url: resp(url, text=page))
    jid = store.new_job(tmp_path, "https://acme.example/careers/data-analyst")["job_id"]
    assert resolve.resolve(tmp_path, jid)["how"] == "employer page"
    other = store.new_job(tmp_path, "https://acme.example/careers/data-analyst-2")["job_id"]
    store.new_job(tmp_path, LV)  # already in the list from a watched board
    assert resolve.resolve(tmp_path, other)["duplicate_of"] == store.job_id_for(LV)
    two = page + f'<a href="https://jobs.ashbyhq.com/acme/7d1e2f3a-4b5c-4d6e-9f70-8a9b0c1d2e3f">Other</a>'
    monkeypatch.setattr(fetch, "_get", lambda url: resp(url, text=two))
    third = store.new_job(tmp_path, "https://acme.example/careers")["job_id"]
    assert resolve.resolve(tmp_path, third)["resolved"] is False  # two different postings linked: no guess
