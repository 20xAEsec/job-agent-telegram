"""Stage f: discovery prefilter (title-match strictness table, DESIGN 4.9), boards/seen store, and `discover poll` with a faked API."""
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from jobagent import cli, store
from jobagent.discover import ats_api, boards
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
     "min_salary": 200_000, "allow_unknown_salary": True, "exclude_keywords": ["intern"], "company_blocklist": ["Cubic"], "posted_within_days": 14}
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
    (tmp_path / "settings.json").write_text(json.dumps({"filters": F}), "utf-8")
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
    assert sorted(boards.seen(data)) == ["greenhouse-acme-2", "greenhouse-acme-3"]
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
