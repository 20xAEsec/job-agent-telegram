"""Watched Lever and Ashby boards, structured pay, `boards check` across ATSs, and LinkedIn results read from the public job page.
APIs are faked (no network); shapes follow the recorded fixtures."""
import json
from datetime import datetime, timezone

import httpx
import pytest

from jobagent import fetch, store
from jobagent.discover import ats_api, boards, sites
from test_discover import F
from test_jobs import FX

LEVER_JOB = json.loads((FX / "lever_posting.json").read_text("utf-8"))
ASHBY = json.loads((FX / "ashby_board.json").read_text("utf-8"))
NOW = datetime.now(timezone.utc)


def resp(url, status=200, body=None):
    return httpx.Response(status, json=body if body is not None else {}, request=httpx.Request("GET", url))


@pytest.fixture
def api(monkeypatch):
    """Fake board APIs: url substring -> JSON (missing = 404)."""
    routes = {}

    def get(url):
        hit = next((v for k, v in routes.items() if k in url), None)
        return resp(url, 404) if hit is None else resp(url, 200, hit)

    monkeypatch.setattr(ats_api, "_get", get)
    monkeypatch.setattr(fetch, "_get", get)  # boards.check and ashby.board_jobs use fetch._get
    return routes


def test_lever_and_ashby_listers(api):
    lv = {**LEVER_JOB, "createdAt": NOW.timestamp() * 1000}
    api.update({"api.lever.co/v0/postings/acme": [lv, {**lv, "id": "x", "text": "Chef", "salaryRange": {"currency": "EUR", "interval": "per-year-salary", "max": 90000}}],
                "posting-api/job-board/beta": ASHBY})
    errs = []
    got = ats_api._lever(["acme", "gone"], "USD", errs)
    assert got[0] == {"title": "Data Analyst", "company": "acme", "location": "Austin, TX (Remote)", "url": LEVER_JOB["hostedUrl"], "board": "acme",
                      "posted": got[0]["posted"], "salary_max": 125000, "dept": got[0]["dept"], "blurb": got[0]["blurb"]}
    assert "Data" in got[0]["dept"] and "We need a Data Analyst." in got[0]["blurb"] and "Write SQL" in got[0]["blurb"]  # text + requirement lists
    assert got[1]["salary_max"] is None and errs == [{"board": "gone", "error": "HTTP 404"}]  # other currency: unknown, not wrong
    got = ats_api._ashby(["beta"], "USD", errs)
    assert [g["title"] for g in got] == ["Data Analyst", "Office Chef"]  # the unlisted one stays out
    assert got[0]["location"] == "Austin (Remote)" and got[0]["salary_max"] == 140000 and got[0]["posted"].startswith("2026-11-22")
    assert got[0]["url"] == "https://jobs.ashbyhq.com/acme/7d1e2f3a-4b5c-4d6e-9f70-8a9b0c1d2e3f"
    assert (got[0]["dept"], got[0]["blurb"]) == ("Data Analytics", "Acme builds widgets. We need a Data Analyst.")


def test_greenhouse_lists_light_and_reads_one_posting(api):
    gh = json.loads((FX / "gh_job.json").read_text("utf-8"))
    api.update({"boards-api.greenhouse.io/v1/boards/acme/jobs/123": {**gh, "departments": [{"id": 1, "name": "Data"}]},
                "boards-api.greenhouse.io/v1/boards/acme/jobs?": {"jobs": [{k: v for k, v in gh.items() if k in ("id", "title", "location")}]}})
    got = ats_api._greenhouse(["acme"], "USD", [])
    assert [(g["title"], g["url"], g["salary_max"]) for g in got] == [("Data Analyst", "https://job-boards.greenhouse.io/acme/jobs/123", None)]
    one = ats_api._gh_detail("acme", "123", "USD")
    assert one["dept"] == "Data" and "We need a Data Analyst." in one["blurb"] and "<p>" not in one["blurb"]
    assert ats_api._gh_detail("acme", "999", "USD") == {}  # unreadable: nothing, never an error


def test_poll_covers_every_watched_ats(tmp_path, api):
    (tmp_path / "settings.json").write_text(json.dumps({"filters": {**F, "titles": ["Data Analyst"], "min_salary": None}, "discovery": {"sources": ["companies"]}}))
    boards.add(tmp_path, "lever", ["acme"])
    boards.add(tmp_path, "ashby", ["beta"])
    api.update({"api.lever.co/v0/postings/acme": [{**LEVER_JOB, "createdAt": NOW.timestamp() * 1000}], "posting-api/job-board/beta": ASHBY})
    r = ats_api.poll(tmp_path)
    assert r["boards"] == 2 and [c["job_id"].split("-")[0] for c in r["candidates"]] == ["lever", "ashby"]
    assert r["candidates"][0]["job_id"] == "lever-acme-2f3c9a1e-5b6d-4c7e-8f90-1a2b3c4d5e6f"


def test_greenhouse_structured_pay_wins_over_the_text():
    j = {"content": "&lt;p&gt;$100,000 - $120,000&lt;/p&gt;", "pay_input_ranges": [{"min_cents": 15000000, "max_cents": 19000000, "currency_type": "USD"},
                                                                                {"min_cents": 1, "max_cents": 25000000, "currency_type": "CAD"}]}
    assert ats_api._gh_pay(j, "USD") == 190_000 and ats_api._gh_pay(j, "GBP") is None and ats_api._gh_pay({}, "USD") is None


def test_salary_in_the_users_currency():
    assert ats_api.salary_max("Salary £55,000 - £70,000 per year", "GBP") == 70_000
    assert ats_api.salary_max("Salary £55,000 - £70,000 per year", "USD") is None  # not dollars: unknown
    assert ats_api.salary_max("€60k – €80k", "EUR") == 80_000 and ats_api.salary_max("$25 - $40 an hour") is None


def test_boards_check_finds_the_ats_and_remove_any(tmp_path, api):
    api.update({"boards-api.greenhouse.io/v1/boards/gh": {"name": "GH Co", "jobs": [1, 2]}, "api.lever.co/v0/postings/lv-co": [LEVER_JOB],
                "posting-api/job-board/ab": ASHBY, "posting-api/job-board/empty": {"jobs": []}})
    assert boards.check("GH") == {"ok": True, "ats": "greenhouse", "slug": "gh", "company": "GH Co", "open_jobs": 2}
    assert boards.check("lv-co") == {"ok": True, "ats": "lever", "slug": "lv-co", "company": "Lv Co", "open_jobs": 1}
    assert boards.check("ab")["ats"] == "ashby" and boards.check("ab", "lever")["code"] == "not_found"
    assert boards.check("empty")["code"] == "not_found" and boards.check("../x")["code"] == "bad_slug"
    boards.add(tmp_path, "lever", ["acme"])
    boards.add(tmp_path, "greenhouse", ["acme", "beta"])
    assert boards.remove(tmp_path, "any", ["acme"])["boards"] == {"greenhouse": ["beta"], "lever": [], "ashby": []}


def test_kept_linkedin_results_get_the_public_page_and_upgrade_to_the_employer_form(tmp_path, monkeypatch):
    (tmp_path / "settings.json").write_text(json.dumps({"filters": {**F, "min_salary": None}, "discovery": {"sources": ["linkedin"]}}))
    rows = [{"title": "Detection Engineer", "company": "Acme", "location": "Remote", "url": f"https://www.linkedin.com/jobs/view/{i}", "site": "LinkedIn",
             "posted": "", "salary_max": None, "description": ""} for i in (1, 2)]
    rows[1]["company"] = "Zeta"
    rows.append({**rows[0], "title": "Chef", "url": "https://www.linkedin.com/jobs/view/3"})  # dropped by the prefilter: never fetched
    monkeypatch.setattr(sites, "search", lambda d, f, chosen, hours: (rows, [], []))
    asked, pages = [], {"1": fetch.parse_linkedin((FX / "linkedin_guest.html").read_text("utf-8")), "2": None}
    monkeypatch.setattr(fetch, "linkedin_guest", lambda u: (asked.append(u), pages[u.rsplit("/", 1)[1]])[1])
    monkeypatch.setattr(ats_api.time, "sleep", lambda s: None)
    r = ats_api.poll(tmp_path)
    assert asked == ["https://www.linkedin.com/jobs/view/1", "https://www.linkedin.com/jobs/view/2"]
    a, z = r["candidates"]
    assert a["job_id"] == "lever-acme-2f3c9a1e-5b6d-4c7e-8f90-1a2b3c4d5e6f" and a["listed_at"] == "https://www.linkedin.com/jobs/view/1"
    assert z["job_id"].startswith("web-") and not (tmp_path / "listings" / f"{z['job_id']}.md").exists()  # no page, no listing
    assert "We need a Data Analyst." in (tmp_path / "listings" / f"{a['job_id']}.md").read_text("utf-8")
