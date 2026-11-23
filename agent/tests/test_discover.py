"""Stage f: discovery prefilter (title-match strictness table, DESIGN 4.9), boards/seen store, and `discover poll` with a faked API."""
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from jobagent import cli, fetch, store
from jobagent.discover import ats_api, boards, sites
from jobagent.discover.prefilter import drop_reason, title_matches

# (title, wanted, exact, close, broad): each level accepts everything the stricter one does.
TABLE = [
    ("Detection Engineer", "Detection Engineer", True, True, True),
    ("detection  ENGINEER", "Detection Engineer", True, True, True),
    ("Senior Detection Engineer", "Detection Engineer", False, True, True),
    ("Detection & Response Engineer", "Detection Engineer", False, True, True),
    ("Cybersecurity Engineer", "Cyber Security Engineer", False, True, True),  # synonym table
    ("Information Security Engineer", "Cyber Security Engineer", False, True, True),  # synonym table
    ("Software Engineer", "Detection Engineer", False, False, True),  # ratio between 60 and 80
    ("Senior Security Analyst", "Security Analyst", False, True, True),
    ("Marketing Manager", "Detection Engineer", False, False, False),
]


@pytest.mark.parametrize("title,wanted,exact,close,broad", TABLE)
def test_title_match_strictness(title, wanted, exact, close, broad):
    assert [title_matches(title, [wanted], m) for m in ("exact", "close", "broad")] == [exact, close, broad]


F = {"titles": ["Detection Engineer"], "title_match": "close", "locations": ["San Diego", "Remote"], "remote": "remote_or_hybrid",
     "min_salary": 200_000, "allow_unknown_salary": True, "exclude_keywords": ["intern"], "company_blocklist": ["Cubic"], "posted_within_hours": 336}
NOW = datetime(2026, 11, 22, tzinfo=timezone.utc)


def cand(**kw):
    return {"title": "Detection Engineer", "company": "Acme", "location": "Remote - US", "posted": NOW.isoformat(), "salary_max": None, **kw}


@pytest.mark.parametrize("kw,filters,why", [
    ({}, {}, None),
    ({"title": "Marketing Manager"}, {}, "title"),
    ({"location": "Berlin"}, {}, "location"),
    ({"location": "San Diego, CA"}, {}, None),
    ({"location": "Hybrid - Austin"}, {}, None),
    ({"location": "San Diego, CA"}, {"remote": "remote_only"}, "location"),
    ({"location": "Remote"}, {"remote": "onsite_only"}, "location"),
    ({"location": "Berlin"}, {"remote": "any"}, None),
    ({"location": ""}, {}, None),  # unknown location passes
    ({"title": "Detection Engineer Intern"}, {}, "exclude_keyword"),
    ({"company": "Cubic Corporation"}, {}, "company_blocklist"),
    ({"company": "Cubicle Co"}, {}, None),
    ({"posted": (NOW - timedelta(days=30)).isoformat()}, {}, "too_old"),
    ({"posted": ""}, {}, None),
    ({"posted": (NOW - timedelta(hours=7)).isoformat()}, {"posted_within_hours": 6}, "too_old"),
    ({"posted": (NOW - timedelta(hours=5)).isoformat()}, {"posted_within_hours": 6}, None),
    ({"posted": (NOW - timedelta(days=3)).isoformat()}, {"posted_within_hours": None, "posted_within_days": 2}, "too_old"),  # older settings files
    ({"salary_max": 150_000}, {}, "salary"),
    ({"salary_max": 250_000}, {}, None),
    ({"salary_max": None}, {"allow_unknown_salary": False}, "salary"),
    ({}, {"min_salary": None, "allow_unknown_salary": False}, None),
])
def test_prefilter(kw, filters, why):
    assert drop_reason(cand(**kw), {**F, **filters}, NOW) == why


def test_salary_max():
    assert ats_api.salary_max("Pay range: $180,000 - $240,000 USD") == 240_000
    assert ats_api.salary_max("$150k – $210k plus equity") == 210_000
    assert ats_api.salary_max("raised $50M, founded 2015, 10-20 people") is None


def gh(*jobs):
    return {"jobs": [{"id": i, "title": t, "company_name": c, "location": {"name": loc}, "first_published": datetime.now(timezone.utc).isoformat(),
                      "content": "&lt;p&gt;$220,000 - $260,000&lt;/p&gt;"} for i, t, c, loc in jobs]}


@pytest.fixture
def data(tmp_path, monkeypatch):
    (tmp_path / "settings.json").write_text(json.dumps({"filters": F, "discovery": {"sources": ["companies"]}}), "utf-8")
    boards.add(tmp_path, "greenhouse", ["acme", "beta", "gone"])
    api = {"acme": gh((1, "Detection Engineer", "Acme", "Remote"), (2, "Chef", "Acme", "Remote"), (3, "Detection Engineer", "Cubic", "Remote")),
           "beta": gh((7, "Senior Detection Engineer", "Beta", "San Diego"))}

    def fake_get(url):
        board = url.split("/boards/")[1].split("/")[0]
        return httpx.Response(200 if board in api else 404, json=api.get(board, {}), request=httpx.Request("GET", url))

    monkeypatch.setattr(ats_api, "_get", fake_get)
    return tmp_path


def test_poll_keeps_new_matches_and_never_repeats(data):
    r = ats_api.poll(data)
    assert [c["job_id"] for c in r["candidates"]] == ["greenhouse-acme-1", "greenhouse-beta-7"]
    assert (r["found"], r["new"], r["kept"], r["dropped"]) == (4, 4, 2, {"title": 1, "company_blocklist": 1})
    assert r["errors"][0]["board"] == "gone"
    assert r["candidates"][0]["salary_max"] == 260_000 and r["candidates"][0]["url"] == "https://job-boards.greenhouse.io/acme/jobs/1"
    # Dropped jobs are remembered at once; kept ones come back until a job exists for them (nothing lost if intake never ran).
    assert sorted(k for k in boards.seen(data) if not k.startswith("dup-")) == ["greenhouse-acme-2", "greenhouse-acme-3"]
    assert len(ats_api.poll(data)["candidates"]) == 2
    for c in r["candidates"]:
        store.new_job(data, c["url"], "discovery")
    r2 = ats_api.poll(data)
    assert (r2["new"], r2["kept"], r2["candidates"]) == (0, 0, [])


def test_poll_needs_titles(tmp_path):
    (tmp_path / "settings.json").write_text(json.dumps({"filters": {"titles": []}}), "utf-8")
    assert ats_api.poll(tmp_path)["code"] == "no_titles"


def test_boards_cli(tmp_path, capsys):
    assert cli.main(["--data-dir", str(tmp_path), "boards", "add", "greenhouse", "Acme", "beta"]) == 0
    assert json.loads(capsys.readouterr().out)["boards"] == {"greenhouse": ["acme", "beta"]}
    assert cli.main(["--data-dir", str(tmp_path), "boards", "add", "greenhouse", "../etc"]) == 1
    assert json.loads(capsys.readouterr().out)["code"] == "bad_slug"
    assert cli.main(["--data-dir", str(tmp_path), "boards", "list"]) == 0
    assert json.loads(capsys.readouterr().out)["boards"]["greenhouse"] == ["acme", "beta"]


def test_boards_remove(tmp_path):
    boards.add(tmp_path, "greenhouse", ["acme", "beta"])
    assert boards.remove(tmp_path, "greenhouse", ["ACME"])["boards"] == {"greenhouse": ["beta"]}


def site(title, company, url, **kw):
    return {"title": title, "company": company, "location": "Remote", "url": url, "site": "Indeed", "posted": "", "salary_max": None, "description": "", **kw}


def test_poll_job_sites_dedupe_and_save_listings(data, monkeypatch):
    (data / "settings.json").write_text(json.dumps({"filters": F, "discovery": {"sources": ["companies", "indeed", "linkedin"]}}), "utf-8")
    asked = []

    def fake_search(d, f, chosen, hours):
        asked.append((chosen, hours))
        return [site("Detection Engineer", "Zeta", "https://www.indeed.com/viewjob?jk=aaa&from=x", description="We need a detection engineer."),
                site("Detection Engineer", "Zeta Inc.", "https://www.linkedin.com/jobs/view/1"),  # same opening on another site
                site("Detection Engineer", "Omega", "https://www.indeed.com/viewjob?jk=bbb"),
                site("Chef", "Omega", "https://www.indeed.com/viewjob?jk=ccc"),
                site("Detection Engineer", "Acme", "https://job-boards.greenhouse.io/acme/jobs/1")], [{"site": "LinkedIn", "error": "429"}], []

    monkeypatch.setattr(sites, "search", fake_search)
    r = ats_api.poll(data)
    assert asked == [(["linkedin", "indeed"], 336)] and r["sites"] == ["LinkedIn", "Indeed"]
    urls = [c["url"] for c in r["candidates"]]
    assert urls == ["https://job-boards.greenhouse.io/acme/jobs/1", "https://job-boards.greenhouse.io/beta/jobs/7",
                    "https://www.indeed.com/viewjob?jk=aaa", "https://www.indeed.com/viewjob?jk=bbb"]  # Acme from Indeed = the board job: once
    assert r["errors"][-1] == {"site": "LinkedIn", "error": "429"} and r["dropped"] == {"title": 2, "company_blocklist": 1}
    zeta = r["candidates"][2]
    assert "description" not in zeta and zeta["site"] == "Indeed"
    # the saved listing stands in for the blocked page when intake fetches it
    assert store.new_job(data, zeta["url"], "discovery")["job_id"] == zeta["job_id"]
    monkeypatch.setattr(fetch, "_get", lambda u: pytest.fail("must not download"))
    assert fetch.fetch(data, zeta["job_id"])["ok"]
    assert "We need a detection engineer." in (store.jdir(data, zeta["job_id"]) / "posting.md").read_text("utf-8")
    # next run: the LinkedIn copy of Zeta stays out even though its URL is new
    assert "https://www.linkedin.com/jobs/view/1" not in [c["url"] for c in ats_api.poll(data)["candidates"]]


def test_site_queries_use_settings_only():
    f = {"titles": ["Data Analyst", "BI Analyst", "Analytics Engineer", "Fourth"], "locations": ["Austin, TX", "Remote US", "Denver"], "remote": "remote_or_hybrid", "currency": "USD"}
    c, q = sites.queries(f)
    assert c == "usa" and len(q) == 9
    assert q[:3] == [("Data Analyst", "Austin, TX", False), ("Data Analyst", "Denver", False), ("Data Analyst remote", "United States", True)]
    assert sites.queries({**f, "remote": "remote_only"})[1][0] == ("Data Analyst remote", "United States", True)
    assert all(not r for _, _, r in sites.queries({**f, "remote": "onsite_only"})[1])
    assert sites.queries({"titles": ["X"], "locations": ["Berlin, Germany"], "currency": "EUR", "remote": "onsite_only"}) == ("germany", [("X", "Berlin, Germany", False)])


def test_site_row_to_candidate():
    nan = float("nan")
    c = sites._cand({"site": "indeed", "title": "Analyst", "company": "Co", "location": "Austin, TX", "is_remote": True, "job_url": "https://www.indeed.com/viewjob?jk=1",
                     "job_url_direct": "https://boards.greenhouse.io/co/jobs/55", "max_amount": 120000.0, "min_amount": nan, "currency": "USD", "description": nan}, "USD")
    assert (c["url"], c["location"], c["salary_max"], c["description"], c["site"]) == ("https://boards.greenhouse.io/co/jobs/55", "Austin, TX (Remote)", 120000, "", "Indeed")
    assert sites._cand({"site": "linkedin", "job_url": "https://www.linkedin.com/jobs/view/2", "max_amount": 90000.0, "currency": "EUR"}, "USD")["salary_max"] is None


def test_site_budgets_rotation_and_backoff(tmp_path, monkeypatch):
    import logging

    import jobspy
    import pandas as pd

    calls, li_total = [], [0]

    def fake_scrape(site_name, search_term, location, **kw):
        calls.append((site_name[0], search_term, location, kw["results_wanted"]))
        li_total[0] += site_name[0] == "linkedin"
        if site_name[0] == "linkedin" and li_total[0] == 3:  # LinkedIn refuses its 3rd search ever
            logging.getLogger("jobspy.linkedin").error("response status code 429")
        return pd.DataFrame([])

    monkeypatch.setattr(jobspy, "scrape_jobs", fake_scrape)
    monkeypatch.setattr(sites.time, "sleep", lambda s: None)
    f = {"titles": ["A", "B", "C"], "locations": ["Austin, TX", "Denver"], "remote": "remote_or_hybrid", "currency": "USD"}  # 9 searches
    t0 = datetime(2026, 11, 23, 12, tzinfo=timezone.utc)
    _, errs, skipped = sites.search(tmp_path, f, ["linkedin", "indeed"], 6, t0)
    li = [c for c in calls if c[0] == "linkedin"]
    assert len(li) == 3 and all(c[3] == 10 for c in li)  # one 10-job page each; stopped at the refusal (budget was 4)
    assert len([c for c in calls if c[0] == "indeed"]) == 9 and errs == [{"site": "LinkedIn", "error": "response status code 429"}] and skipped == []
    st = json.loads((tmp_path / "sites.json").read_text("utf-8"))
    assert st["linkedin"]["cursor"] == 2 and "paused_until" in st["linkedin"] and "paused_until" not in st["indeed"]
    # an hour later LinkedIn is still paused (no request at all); Indeed runs again
    calls.clear()
    _, _, skipped = sites.search(tmp_path, f, ["linkedin", "indeed"], 6, t0 + timedelta(hours=1))
    assert [c[0] for c in calls] == ["indeed"] * 9 and "slow down" in skipped[0]["reason"]
    # after the pause it resumes where it stopped: the refused search goes first, 4 at most
    calls.clear()
    sites.search(tmp_path, f, ["linkedin"], 6, t0 + timedelta(hours=7))
    assert [c[1:3] for c in calls] == [sites.queries(f)[1][i][:2] for i in (2, 3, 4, 5)]
    # a second run within the minimum gap does not touch LinkedIn
    calls.clear()
    assert "less than 50 minutes" in sites.search(tmp_path, f, ["linkedin"], 6, t0 + timedelta(hours=7, minutes=10))[2][0]["reason"] and calls == []
