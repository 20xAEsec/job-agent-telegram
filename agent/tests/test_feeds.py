"""discover/feeds.py: each feed's parser on a small inline sample (HTTP faked), the run gap and pause in feeds.json, and one failing feed not stopping the rest."""
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from jobagent.discover import feeds

NOW = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)
F = {"titles": ["Security Engineer", "Detection Engineer"], "related_titles": [], "remote": "remote_or_hybrid", "country": "United States", "currency": "USD"}
DAY = (NOW - timedelta(days=1)).isoformat()
OLD = (NOW - timedelta(days=30)).isoformat()


def fake(routes: dict):
    """_http stand-in: the first route whose key is in the URL answers; a body that is an exception is raised."""
    def http(url, headers=None, body=None):
        fake.calls.append((url, headers, body))
        for k, v in routes.items():
            if k in url:
                if isinstance(v, Exception):
                    raise v
                req = httpx.Request("GET", url)
                return httpx.Response(200, text=v, request=req) if isinstance(v, str) else httpx.Response(200, json=v, request=req)
        raise AssertionError(f"unexpected URL {url}")
    fake.calls = []
    return http


def one(tmp_path, monkeypatch, key, routes, f=F, hours=336):
    monkeypatch.setattr(feeds, "_http", fake(routes))
    found, errs, skipped = feeds.search(tmp_path, f, [key], hours, NOW)
    assert errs == [] and skipped == []
    return found


def test_himalayas(tmp_path, monkeypatch):
    jobs = [{"title": "Security Engineer", "companyName": "Upwind", "locationRestrictions": ["United States"], "guid": "https://himalayas.app/companies/upwind/jobs/se",
             "pubDate": int((NOW - timedelta(hours=5)).timestamp()), "maxSalary": 230000, "currency": "USD", "salaryPeriod": "annual",
             "description": "<p>Build <b>detections</b></p>", "employmentType": "Full Time"},
            {"title": "Security Engineer", "companyName": "Aus", "locationRestrictions": ["Australia"], "guid": "https://himalayas.app/x", "pubDate": 0}]
    got = one(tmp_path, monkeypatch, "himalayas", {"himalayas.app": {"jobs": jobs}})
    assert got == [{"title": "Security Engineer", "company": "Upwind", "location": "United States (Remote)", "url": "https://himalayas.app/companies/upwind/jobs/se",
                    "site": "Himalayas", "posted": (NOW - timedelta(hours=5)).isoformat(), "salary_max": 230000, "description": "Build detections", "kind": "Full Time"}]
    assert "q=Security%20Engineer&country=US" in fake.calls[0][0] and len(fake.calls) == 2  # one search per title


def test_jobicy(tmp_path, monkeypatch):
    jobs = [{"jobTitle": "Sr. Application Security Engineer", "companyName": "Co", "jobGeo": "USA", "url": "https://jobicy.com/jobs/1", "pubDate": DAY,
             "annualSalaryMax": 240000, "salaryCurrency": "USD", "jobDescription": "<p>AppSec</p>", "jobType": ["Full-Time"]},
            {"jobTitle": "Account Executive", "companyName": "Co", "url": "https://jobicy.com/jobs/2", "pubDate": DAY}]
    got = one(tmp_path, monkeypatch, "jobicy", {"jobicy.com": {"jobs": jobs}})
    assert [(c["title"], c["location"], c["salary_max"], c["kind"]) for c in got] == [("Sr. Application Security Engineer", "USA (Remote)", 240000, "Full-Time")]
    assert "geo=usa" in fake.calls[0][0] and "industry=security" in fake.calls[0][0]


def test_remoteok(tmp_path, monkeypatch):
    body = [{"legal": "terms"}, {"position": "Security Engineer", "company": "A", "location": "United States", "url": "https://remoteOK.com/remote-jobs/1",
                                 "date": DAY, "salary_max": 250000, "description": "<p>x</p>"},
            {"position": "Security Engineer", "company": "B", "location": "Canada Only", "url": "https://remoteOK.com/remote-jobs/2", "date": DAY},
            {"position": "Security Engineer", "company": "C", "location": "", "url": "https://remoteOK.com/remote-jobs/3", "date": OLD},
            {"position": "Designer", "company": "D", "url": "https://remoteOK.com/remote-jobs/4", "date": DAY}]
    got = one(tmp_path, monkeypatch, "remoteok", {"remoteok.com": body})
    assert [(c["company"], c["location"], c["salary_max"]) for c in got] == [("A", "United States (Remote)", 250000)]


WWR = """<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss"><channel><title>WWR</title>
<item><title>6sense: Staff Security Engineer - SecOps &amp; Threats</title><region>USA Only</region><type>Full-Time</type>
<description>&lt;p&gt;Hunt &amp;amp; respond&lt;/p&gt;</description><pubDate>Thu, 26 Nov 2026 20:40:40 +0000</pubDate>
<link>https://weworkremotely.com/remote-jobs/6sense-staff-security-engineer</link></item>
<item><title>Keeper: Security Engineer (UK)</title><region>Europe Only</region><pubDate>Thu, 26 Nov 2026 20:40:40 +0000</pubDate><link>https://weworkremotely.com/remote-jobs/k</link></item>
<item><title>Outmarket AI: Head of Content</title><region>USA Only</region><pubDate>Thu, 26 Nov 2026 20:40:40 +0000</pubDate><link>https://weworkremotely.com/remote-jobs/o</link></item>
</channel></rss>"""


def test_wwr(tmp_path, monkeypatch):
    got = one(tmp_path, monkeypatch, "wwr", {"weworkremotely.com": WWR})
    assert got == [{"title": "Staff Security Engineer - SecOps & Threats", "company": "6sense", "location": "USA Only (Remote)",
                    "url": "https://weworkremotely.com/remote-jobs/6sense-staff-security-engineer", "site": "We Work Remotely",
                    "posted": "2026-11-26T20:40:40+00:00", "salary_max": None, "description": "Hunt & respond", "kind": "Full-Time"}]


def test_workingnomads(tmp_path, monkeypatch):
    body = [{"url": "https://www.workingnomads.com/job/go/1/", "title": "Detection Engineer", "company_name": "N", "location": "US, Canada",
             "pub_date": "2026-11-27T01:15:47-05:00", "description": "<p>d</p>"},
            {"url": "https://www.workingnomads.com/job/go/2/", "title": "Back-end Developer", "company_name": "L", "pub_date": DAY}]
    got = one(tmp_path, monkeypatch, "workingnomads", {"workingnomads.com": body})
    assert [(c["title"], c["location"], c["posted"]) for c in got] == [("Detection Engineer", "US, Canada (Remote)", "2026-11-27T01:15:47-05:00")]


def test_dice(tmp_path, monkeypatch):
    data = [{"title": "Splunk Security Engineer", "companyName": "SAIC", "jobLocation": {"displayName": "Arlington, Virginia, USA"},
             "detailsPageUrl": "https://www.dice.com/job-detail/1", "postedDate": "2026-11-25T06:25:00Z", "salary": "USD 160,001.00 - 200,000.00 per year",
             "summary": "Minimum Clearance Required: Secret", "employmentType": "Full-time", "isRemote": False},
            {"title": "Entra ID Engineer", "companyName": "R", "jobLocation": {"displayName": "Reston, Virginia, USA"}, "detailsPageUrl": "https://www.dice.com/job-detail/2",
             "postedDate": "2026-11-25T06:25:00Z", "salary": "$60 - $70 hourly", "isRemote": True},
            {"title": "X", "detailsPageUrl": "https://www.dice.com/job-detail/3", "postedDate": "2026-11-25T06:25:00Z", "salary": "Depends on Experience"}]
    got = one(tmp_path, monkeypatch, "dice", {"dhigroupinc.com": {"data": data}}, hours=72)
    assert [(c["location"], c["salary_max"], c["posted"]) for c in got] == [
        ("Arlington, Virginia, USA", 200000, "2026-11-25T06:25:00+00:00"), ("Reston, Virginia, USA (Remote)", 145600, "2026-11-25T06:25:00+00:00"), ("", None, "2026-11-25T06:25:00+00:00")]
    url, headers, _ = fake.calls[0]
    assert headers == {"x-api-key": feeds.DICE_KEY} and "filters.postedDate=THREE" in url and "q=Security+Engineer" in url


def test_clearancejobs(tmp_path, monkeypatch):
    data = [{"job_name": "Detection Engineer", "job_url": "https://www.clearancejobs.com/jobs/9/detection-engineer", "company_name": "Blu Omega",
             "locations": [{"location": "Remote/Hybrid", "type": None}, {"location": "Rockville, MD", "type": "Off-Site/Hybrid"}],
             "created_at": "2026-11-20T21:10:01-05:00", "clearance": "Public Trust", "preview_text": "Support a federal SOC", "salary_min": 70000, "salary_max": 90000}]
    got = one(tmp_path, monkeypatch, "clearancejobs", {"clearancejobs.com": {"data": data}})
    assert [(c["title"], c["location"], c["salary_max"], c["description"]) for c in got] == [
        ("Detection Engineer", "Rockville, MD (Remote)", 90000, "Clearance: Public Trust\n\nSupport a federal SOC")]
    assert fake.calls[0][2] == {"keywords": "Security Engineer", "limit": 50, "sort": "date", "remote": True}


def test_hn(tmp_path, monkeypatch):
    hits = {"hits": [{"objectID": "8", "title": "Ask HN: Who wants to be hired? (November 2026)"}, {"objectID": "7", "title": "Ask HN: Who is hiring? (November 2026)"}]}
    kids = [{"id": 71, "created_at": "2026-11-02T16:01:43.000Z", "text": "Acme | Senior Security Engineer | Remote | Full-time<p>We build <a href=\"x\">things</a>"},
            {"id": 72, "created_at": "2026-11-02T16:01:43.000Z", "text": "Shop | Frontend Engineer | Utrecht | ONSITE<p>React"},
            {"id": 73, "created_at": "2026-11-02T16:01:43.000Z", "text": None}]
    got = one(tmp_path, monkeypatch, "hn", {"search_by_date": hits, "items/7": {"children": kids}}, hours=720)  # the thread is monthly
    assert [(c["title"], c["company"], c["location"], c["url"]) for c in got] == [
        ("Senior Security Engineer", "Acme", "Remote", "https://news.ycombinator.com/item?id=71")]
    assert got[0]["posted"] == "2026-11-02T16:01:43+00:00" and got[0]["description"].startswith("Acme | Senior")


def test_gap_and_pause(tmp_path, monkeypatch):
    monkeypatch.setattr(feeds, "_http", fake({"remoteok.com": feeds.Refused("HTTP 429"), "workingnomads.com": []}))
    _, errs, skipped = feeds.search(tmp_path, F, ["remoteok", "workingnomads"], 24, NOW)
    assert errs == [{"site": "Remote OK", "error": "HTTP 429"}] and skipped == []
    st = json.loads((tmp_path / "feeds.json").read_text("utf-8"))
    assert st["remoteok"]["paused_until"] == (NOW + timedelta(hours=feeds.COOLDOWN_HOURS)).isoformat() and "paused_until" not in st["workingnomads"]
    _, _, skipped = feeds.search(tmp_path, F, ["remoteok", "workingnomads"], 24, NOW + timedelta(minutes=20))
    assert [s["site"] for s in skipped] == ["Remote OK", "Working Nomads"] and "slow down" in skipped[0]["reason"] and "minutes ago" in skipped[1]["reason"]
    fake.calls.clear()
    _, errs, skipped = feeds.search(tmp_path, F, ["remoteok", "workingnomads"], 24, NOW + timedelta(hours=2))
    assert [s["site"] for s in skipped] == ["Remote OK"] and errs == [] and [u for u, _, _ in fake.calls] == ["https://www.workingnomads.com/api/exposed_jobs/"]
    monkeypatch.setattr(feeds, "_http", fake({"remoteok.com": [{"legal": "x"}]}))
    assert feeds.search(tmp_path, F, ["remoteok"], 24, NOW + timedelta(hours=7))[2] == []  # pause over


def test_failing_feed_does_not_stop_others(tmp_path, monkeypatch):
    body = [{"url": "https://www.workingnomads.com/job/go/1/", "title": "Security Engineer", "company_name": "N", "pub_date": DAY}]
    monkeypatch.setattr(feeds, "_http", fake({"remoteok.com": ValueError("bad json"), "workingnomads.com": body}))
    found, errs, _ = feeds.search(tmp_path, F, ["remoteok", "workingnomads"], 336, NOW)
    assert errs == [{"site": "Remote OK", "error": "ValueError"}] and [c["company"] for c in found] == ["N"]
    assert "paused_until" not in json.loads((tmp_path / "feeds.json").read_text("utf-8"))["remoteok"]  # only a refusal pauses


@pytest.mark.parametrize("where,out", [("Canada Only", True), ("Europe Only", True), ("USA Only", False), ("US only", False), ("Americas Only", False),
                                       ("Anywhere in the World", False), ("Berlin", False)])
def test_abroad_only_when_said(where, out):
    assert feeds._abroad(where) is out


def test_us_only_feeds_skipped_elsewhere(tmp_path, monkeypatch):
    monkeypatch.setattr(feeds, "_http", fake({}))
    _, _, skipped = feeds.search(tmp_path, {**F, "country": "Germany", "currency": "EUR"}, ["dice"], 24, NOW)
    assert skipped == [{"site": "Dice", "reason": "Dice lists jobs in the United States only"}] and fake.calls == []
