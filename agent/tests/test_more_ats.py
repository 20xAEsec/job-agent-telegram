"""Workday, SmartRecruiters, Workable, Eightfold, Amazon and Oracle HCM listers, their detail reads and probes. APIs are faked (no
network); sample shapes follow live responses (Nov 2026)."""
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from jobagent.discover import more_ats as m

NOW = datetime.now(timezone.utc)


@pytest.fixture
def api(monkeypatch):
    """Fake APIs: url substring -> JSON, or an int status (missing = 404). The longest matching key wins. GETs and POSTs share it;
    `calls` records every (method, url, body)."""
    routes, calls = {}, []

    def answer(method, url, body=None):
        calls.append((method, url, body))
        hit = max((k for k in routes if k in url), key=len, default=None)
        v = 404 if hit is None else routes[hit]
        return httpx.Response(v, text="nope", request=httpx.Request(method, url)) if isinstance(v, int) else \
            httpx.Response(200, json=v, request=httpx.Request(method, url))

    monkeypatch.setattr(m, "EF_GAP", 0)
    monkeypatch.setattr(m, "EF_WAIT", 0)
    monkeypatch.setattr(m, "_get", lambda url: answer("GET", url))
    monkeypatch.setattr(httpx, "post", lambda url, json=None, **kw: answer("POST", url, json))
    routes["_calls"] = calls  # never matches a real url
    return routes


def keys_ok(c):
    assert {"title", "company", "location", "url", "board", "posted", "salary_max", "dept", "blurb", "kind"} <= set(c)


# ---- Workday ----

WD = "crowdstrike|wd5|crowdstrikecareers"
WD_LIST = {"total": 2, "jobPostings": [
    {"title": "Security Engineer", "externalPath": "/job/USA---Remote/Security-Engineer_R1", "locationsText": "USA - Austin, TX", "postedOn": "Posted Yesterday",
     "remoteType": "Fully Remote"},
    {"title": "Cloud Security Engineer", "externalPath": "/job/USA---Sunnyvale-CA/Cloud_R2", "locationsText": "2 Locations", "postedOn": "Posted 30+ Days Ago"}]}


def test_workday_lists_each_term_once_per_job(api):
    api["myworkdayjobs.com/wday/cxs/crowdstrike/crowdstrikecareers/jobs"] = WD_LIST
    got = m.LISTERS["workday"](WD, "USD", errs := [], ["security engineer", "cloud security"])
    assert errs == [] and len(got) == 2  # the second term finds the same two: kept once
    keys_ok(got[0])
    assert got[0]["url"] == "https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/USA---Remote/Security-Engineer_R1"
    assert got[0]["location"] == "USA - Austin, TX (Remote)" and got[1]["location"] == ""  # "2 Locations": the detail call names them
    assert got[0]["company"] == "Crowdstrike" and got[0]["detail"] == "workday" and got[0]["blurb"] == "" and got[0]["salary_max"] is None
    when, now = [datetime.fromisoformat(g["posted"]) for g in got], datetime.now(timezone.utc)
    assert abs(now - timedelta(days=1) - when[0]) < timedelta(minutes=5) and abs(now - timedelta(days=31) - when[1]) < timedelta(minutes=5)
    posts = [c for c in api["_calls"] if c[0] == "POST"]
    assert [p[2]["searchText"] for p in posts] == ["security engineer", "cloud security"] and posts[0][2]["limit"] == 20  # under 20 back: no 2nd page


def test_workday_posted_text():
    now = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)
    assert [m._wd_posted(s, now)[:10] for s in ("Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago")] == \
        ["2026-11-27", "2026-11-26", "2026-11-24", "2026-10-27"]
    assert m._wd_posted("", now) == "" and m._wd_posted(None, now) == ""


def test_workday_detail_reads_text_pay_and_places(api):
    api["/wday/cxs/crowdstrike/crowdstrikecareers/job/USA---Sunnyvale-CA/Cloud_R2"] = {"jobPostingInfo": {
        "jobDescription": "<p>Protect clouds.</p><p>The base salary range is $140,000 - $220,000 per year.</p>", "location": "USA - Sunnyvale, CA",
        "additionalLocations": ["USA - Redmond, WA"], "timeType": "Full time"}}
    c = {"board": WD, "url": "https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/USA---Sunnyvale-CA/Cloud_R2"}
    d = m.DETAILS["workday"](c, "USD")
    assert d["description"].startswith("Protect clouds.") and "<p>" not in d["description"] and d["salary_max"] == 220000
    assert d["location"] == "USA - Sunnyvale, CA; USA - Redmond, WA" and d["kind"] == "Full time"
    assert m.DETAILS["workday"](c, "EUR")["salary_max"] == round(220000 / 1.08)  # in the user's currency (eligibility.pay converts)
    assert m.DETAILS["workday"]({**c, "url": c["url"].replace("Cloud_R2", "Gone_R9")}, "USD") == {}  # unreadable: nothing, never an error


def test_workday_errors_recorded(api):
    api["myworkdayjobs.com"] = 500
    assert m.LISTERS["workday"](WD, "USD", errs := [], ["a", "b"]) == [] and errs == [{"board": WD, "error": "HTTP 500"}]  # first failure stops


# ---- SmartRecruiters ----

SR_LIST = {"totalFound": 2, "content": [
    {"id": "744000163889069", "name": "Security Engineer", "company": {"identifier": "ServiceNow", "name": "ServiceNow"}, "releasedDate": "2026-11-26T14:55:19.210Z",
     "location": {"city": "Frankfurt", "country": "de", "remote": False, "fullLocation": "Frankfurt, , Germany"}, "department": {"label": "Security"},
     "typeOfEmployment": {"label": "Full-time"}},
    {"id": "744000163889070", "name": "Cloud Security Engineer", "company": {"name": "ServiceNow"}, "releasedDate": "2026-11-20T10:00:00.000Z",
     "location": {"city": "Denver", "region": "Colorado", "country": "us", "remote": True, "fullLocation": "Denver, Colorado, United States"}}]}


def test_smartrecruiters_lister(api):
    api["api.smartrecruiters.com/v1/companies/ServiceNow/postings?q=security%20engineer"] = SR_LIST
    got = m.LISTERS["smartrecruiters"]("ServiceNow", "USD", errs := [], ["security engineer"])
    keys_ok(got[0])
    assert errs == [] and [g["url"] for g in got] == ["https://jobs.smartrecruiters.com/ServiceNow/744000163889069",
                                                     "https://jobs.smartrecruiters.com/ServiceNow/744000163889070"]
    assert (got[0]["location"], got[1]["location"]) == ("Frankfurt, Germany", "Denver, Colorado, United States (Remote)")
    assert got[0]["posted"] == "2026-11-26T14:55:19.210Z" and got[0]["dept"] == "Security" and got[0]["kind"] == "Full-time"
    assert got[1]["kind"] is None and got[0]["detail"] == "smartrecruiters" and got[0]["company"] == "ServiceNow"
    assert "limit=40" in api["_calls"][0][1]


def test_smartrecruiters_detail_and_errors(api):
    api["/postings/744000163889069"] = {"jobAd": {"sections": {
        "jobDescription": {"title": "Job Description", "text": "<p>Find threats.</p>"},
        "additionalInformation": {"title": "Additional Information", "text": "<p>Pay: $150,000&#xa0;-&#xa0;$180,000 a year.</p>"}}}}
    d = m.DETAILS["smartrecruiters"]({"board": "ServiceNow", "url": "https://jobs.smartrecruiters.com/ServiceNow/744000163889069"}, "USD")
    assert "Job Description" in d["description"] and "Find threats." in d["description"] and d["salary_max"] == 180000
    api["api.smartrecruiters.com"] = 503
    assert m.LISTERS["smartrecruiters"]("ServiceNow", "USD", errs := [], ["a", "b"]) == [] and errs == [{"board": "ServiceNow", "error": "HTTP 503"}]


# ---- Workable ----

WK = {"name": "Hugging Face", "jobs": [
    {"title": "ML Security Engineer", "shortcode": "81B46579FE", "employment_type": "Full-time", "telecommuting": True, "department": "Security",
     "url": "https://apply.workable.com/j/81B46579FE", "published_on": "2026-11-26", "country": "France", "city": "Paris", "state": "Île-de-France",
     "description": "<p>Secure the hub. Salary: €90,000 - €110,000 per year.</p>"},
    {"title": "Office Manager", "shortcode": "C0FFEE", "telecommuting": False, "country": "United States", "city": "New York", "published_on": "",
     "created_at": "2026-11-01", "description": "<p>Run the office. $80,000 - $95,000 a year.</p>"}]}


def test_workable_lists_whole_board_with_text(api):
    api["apply.workable.com/api/v1/widget/accounts/huggingface"] = WK
    got = m.LISTERS["workable"]("huggingface", "USD", errs := [], ["ignored"])
    keys_ok(got[0])
    assert errs == [] and [g["title"] for g in got] == ["ML Security Engineer", "Office Manager"] and "details=true" in api["_calls"][0][1]
    assert got[0]["location"] == "Paris, Île-de-France, France (Remote)" and got[1]["location"] == "New York, United States"
    assert got[0]["company"] == "Hugging Face" and got[0]["url"] == "https://apply.workable.com/j/81B46579FE" and got[0]["kind"] == "Full-time"
    assert got[0]["posted"] == "2026-11-26T23:59:59+00:00" and got[1]["posted"] == "2026-11-01T23:59:59+00:00"  # end of the day: never "hours old"
    assert got[0]["blurb"].startswith("Secure the hub.") and "detail" not in got[0]
    assert got[0]["salary_max"] == round(110000 * 1.08) and got[1]["salary_max"] == 95000  # euros come back in the user's currency


def test_workable_errors_recorded(api):
    api["apply.workable.com"] = 429  # Workable throttles hard
    assert m.LISTERS["workable"]("huggingface", "USD", errs := [], []) == [] and errs == [{"board": "huggingface", "error": "HTTP 429"}]
    assert "workable" not in m.DETAILS  # the listing has the text


# ---- Eightfold ----

EF_V2 = {"count": 2, "positions": [
    {"id": 790316013491, "name": "Security Engineer 5", "location": "Remote, United States", "department": "Engineering", "t_create": 1779321600,
     "work_location_option": "remote", "job_description": ""},
    {"id": 790316013492, "name": "Security Engineer 4", "location": "Los Gatos, California", "department": "Engineering", "t_create": 1779321600,
     "work_location_option": "onsite", "job_description": ""}]}
EF_PCSX = {"status": 200, "data": {"count": 1, "positions": [
    {"id": 1970393557021545, "name": "Senior Security Engineer", "locations": ["United States, Redmond"], "postedTs": 1790809694, "department": "Penetration Testing",
     "workLocationOption": "remote", "positionUrl": "/careers/job/1970393557021545"}]}}


def test_eightfold_old_api(api):
    api["explore.jobs.netflix.net/api/apply/v2/jobs"] = EF_V2
    got = m.LISTERS["eightfold"]("explore.jobs.netflix.net|netflix.com", "USD", errs := [], ["security engineer"])
    keys_ok(got[0])
    assert errs == [] and [g["url"] for g in got] == ["https://explore.jobs.netflix.net/careers/job/790316013491",
                                                     "https://explore.jobs.netflix.net/careers/job/790316013492"]
    assert got[0]["location"] == "Remote, United States" and got[1]["location"] == "Los Gatos, California"  # already says remote: not doubled
    assert got[0]["posted"].startswith("2026-05-21") and got[0]["company"] == "Netflix" and got[0]["detail"] == "eightfold" and got[0]["dept"] == "Engineering"
    assert len(api["_calls"]) == 1  # a short page: no second page


def test_eightfold_falls_back_to_pcsx(api):
    api.update({"apply.careers.microsoft.com/api/apply/v2/jobs": 403, "apply.careers.microsoft.com/api/pcsx/search": EF_PCSX})
    got = m.LISTERS["eightfold"]("apply.careers.microsoft.com|microsoft.com", "USD", errs := [], ["security engineer", "pen tester"])
    assert errs == [] and len(got) == 1 and got[0]["location"] == "United States, Redmond (Remote)" and got[0]["company"] == "Microsoft"
    assert got[0]["url"] == "https://apply.careers.microsoft.com/careers/job/1970393557021545" and got[0]["posted"].startswith("2026-09-30")
    assert [u.split("/api/")[1].split("?")[0] for _, u, _ in api["_calls"]] == ["apply/v2/jobs", "pcsx/search", "pcsx/search"]  # old API asked once


def test_eightfold_detail_and_errors(api):
    api["/api/pcsx/position_details?position_id=1970393557021545&domain=microsoft.com"] = {"data": {
        "jobDescription": "<b>Overview</b><br><p>Break things. USD $117,200 - $229,200 per year.</p>", "location": "United States, Redmond",
        "workLocationOption": "remote", "efcustomTextEmploymentType": ["Full-Time"]}}
    c = {"board": "apply.careers.microsoft.com|microsoft.com", "url": "https://apply.careers.microsoft.com/careers/job/1970393557021545"}
    d = m.DETAILS["eightfold"](c, "USD")
    assert d["description"].startswith("Overview") and d["salary_max"] == 229200 and d["location"] == "United States, Redmond (Remote)" and d["kind"] == "Full-Time"
    api["explore.jobs.netflix.net"] = 429
    assert m.LISTERS["eightfold"]("explore.jobs.netflix.net|netflix.com", "USD", errs := [], ["a"]) == [] and errs == [
        {"board": "explore.jobs.netflix.net|netflix.com", "error": "HTTP 429"}]  # tried twice, recorded once
    assert sum("netflix" in u for _, u, _ in api["_calls"]) == 2


# ---- Amazon ----

AMZ = {"hits": 2, "jobs": [
    {"title": "Security Engineer II", "company_name": "Amazon.com Services LLC", "job_path": "/en/jobs/10614150/security-engineer-ii", "posted_date": "November 25, 2026",
     "normalized_location": "Seattle, Washington, USA", "location": "US, WA, Seattle", "job_family": "Systems Security Engineering", "job_schedule_type": "full-time",
     "locations": ['{"type":"ONSITE","location":"US, WA, Seattle"}'], "description": "Protect AWS.<br/><br/>Pay is $129,300/year to $223,600/year.",
     "basic_qualifications": "- 3+ years of security experience", "preferred_qualifications": "- Python"},
    {"title": "Security Engineer, Virtual", "job_path": "/en/jobs/10614151/security-engineer", "posted_date": "not a date", "location": "US, Virtual",
     "locations": ['{"type":"REMOTE","location":"US, Virtual"}'], "description": "Remote role."}]}


def test_amazon_lister(api):
    api["amazon.jobs/en/search.json"] = AMZ
    got = m.LISTERS["amazon"]("amazon|USA", "USD", errs := [], ["security engineer"])
    keys_ok(got[0])
    assert errs == [] and "base_query=security%20engineer" in api["_calls"][0][1] and "&country=USA" in api["_calls"][0][1]
    assert got[0]["url"] == "https://www.amazon.jobs/en/jobs/10614150/security-engineer-ii" and got[0]["company"] == "Amazon"
    assert got[0]["posted"] == "2026-11-25T23:59:59+00:00" and got[1]["posted"] == ""
    assert got[0]["location"] == "Seattle, Washington, USA" and got[1]["location"] == "US, Virtual (Remote)"
    assert got[0]["salary_max"] == 223600 and "3+ years of security experience" in got[0]["blurb"] and "detail" not in got[0]
    m.LISTERS["amazon"]("amazon", "USD", [], ["x"])
    assert "country" not in api["_calls"][-1][1]  # plain "amazon": every country


def test_amazon_errors_recorded(api):
    assert m.LISTERS["amazon"]("amazon", "USD", errs := [], ["a"]) == [] and errs == [{"board": "amazon", "error": "HTTP 404"}]


# ---- Oracle HCM ----

ORA_B = "eeho.fa.us2.oraclecloud.com|CX_45001|Oracle"
ORA_LIST = {"items": [{"TotalJobsCount": 2, "requisitionList": [
    {"Id": "351363", "Title": "Senior Security Engineer", "PostedDate": "2026-11-24", "PrimaryLocation": "Nashville, TN, United States", "WorkplaceType": ""},
    {"Id": "351364", "Title": "Cloud Security Engineer", "PostedDate": "2026-11-20", "PrimaryLocation": "United States", "WorkplaceType": "Remote",
     "JobFamily": "Security"}]}]}


def test_oracle_lister(api):
    api["eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions"] = ORA_LIST
    got = m.LISTERS["oracle"](ORA_B, "USD", errs := [], ['security, "engineer"'])
    keys_ok(got[0])
    assert errs == [] and "siteNumber=CX_45001,keyword=security%20%20%20engineer%20,limit=25" in api["_calls"][0][1]  # no stray finder separators
    assert got[0]["url"] == "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/351363"
    assert got[0]["company"] == "Oracle" and got[0]["posted"] == "2026-11-24T23:59:59+00:00" and got[0]["detail"] == "oracle"
    assert got[1]["location"] == "United States (Remote)" and got[1]["dept"] == "Security"
    assert m._ora("jpmc.fa.oraclecloud.com|CX_1001")[2] == "Jpmc"  # no name given: the host's first label


def test_oracle_detail_and_errors(api):
    api["recruitingCEJobRequisitionDetails"] = {"items": [{"ExternalDescriptionStr": "<p>Guard the cloud.</p>", "ExternalResponsibilitiesStr": "<ul><li>Triage</li></ul>",
                                                           "ExternalQualificationsStr": "", "PrimaryLocation": "Nashville, TN", "WorkplaceType": "On-site"}]}
    d = m.DETAILS["oracle"]({"board": ORA_B, "url": "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/351363"}, "USD")
    assert d["description"] == "Guard the cloud.\n\n- Triage" and d["salary_max"] is None and d["location"] == "Nashville, TN"
    assert 'Id="351363",siteNumber=CX_45001' in api["_calls"][0][1]
    api["oraclecloud.com"] = 503
    assert m.LISTERS["oracle"](ORA_B, "USD", errs := [], ["a"]) == [] and errs == [{"board": ORA_B, "error": "HTTP 503"}]


# ---- board ids and probes ----

@pytest.mark.parametrize("system,good,bad", [
    ("workday", "crowdstrike|wd5|crowdstrikecareers", "crowdstrike|wd5"),
    ("smartrecruiters", "ServiceNow", "a/b"),
    ("workable", "huggingface", "Hugging Face"),
    ("eightfold", "explore.jobs.netflix.net|netflix.com", "netflix"),
    ("amazon", "amazon|USA", "amazon|usa"),
    ("oracle", "eeho.fa.us2.oraclecloud.com|CX_45001|Oracle", "evil.com|CX_1"),
])
def test_board_ids(system, good, bad):
    assert m.BOARD_RE[system].match(good) and not m.BOARD_RE[system].match(bad)
    assert set(m.BOARD_RE) == set(m.LISTERS) == set(m.PROBES) and set(m.DETAILS) <= set(m.LISTERS)


def test_probes(api):
    api.update({"myworkdayjobs.com": {"total": 371, "jobPostings": []}, "smartrecruiters.com/v1/companies/ServiceNow": SR_LIST,
                "smartrecruiters.com/v1/companies/Nobody": {"totalFound": 0, "content": []}, "widget/accounts/huggingface": WK,
                "apply.careers.microsoft.com/api/apply/v2": 403, "apply.careers.microsoft.com/api/pcsx": EF_PCSX, "amazon.jobs": AMZ,
                "oraclecloud.com": ORA_LIST})
    assert m.PROBES["workday"](WD) == ("Crowdstrike", 371)
    assert m.PROBES["smartrecruiters"]("ServiceNow") == ("ServiceNow", 2) and m.PROBES["smartrecruiters"]("Nobody") is None
    assert m.PROBES["workable"]("huggingface") == ("Hugging Face", 2) and m.PROBES["workable"]("gone") is None
    assert m.PROBES["eightfold"]("apply.careers.microsoft.com|microsoft.com") == ("Microsoft", 1)
    assert m.PROBES["eightfold"]("careers.nobody.com|nobody.com") is None
    assert m.PROBES["amazon"]("amazon") == ("Amazon", 2) and m.PROBES["oracle"](ORA_B) == ("Oracle", 2)
    api["widget/accounts/busy"] = 429
    with pytest.raises(httpx.HTTPStatusError):
        m.PROBES["workable"]("busy")  # throttled is not "no such board"
