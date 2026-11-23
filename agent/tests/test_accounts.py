from datetime import datetime, timedelta, timezone

import pytest

from jobagent import accounts, cli, fetch, store


def test_site_for_and_auth_pages():
    assert accounts.site_for("https://www.linkedin.com/jobs/view/1") == "linkedin"
    assert accounts.site_for("https://uk.indeed.com/viewjob?jk=1") == "indeed"
    assert accounts.site_for("https://notlinkedin.com/jobs/view/1") is None
    assert accounts._on_auth("https://www.linkedin.com/authwall?trk=x") and accounts._on_auth("https://secure.indeed.com/auth?continue=x")
    assert not accounts._on_auth("https://www.linkedin.com/jobs/view/1")


def test_fetch_reads_job_sites_in_the_profile_and_asks_for_login(tmp_path, monkeypatch):
    jid = store.new_job(tmp_path, "https://www.linkedin.com/jobs/search/?currentJobId=77")["job_id"]
    asked = []

    def need_login(d, url):
        asked.append(url)
        raise accounts.NeedsLogin("linkedin")

    monkeypatch.setattr(accounts, "page_text", need_login)
    r = fetch.fetch(tmp_path, jid)
    assert r["code"] == "needs_login" and asked == ["https://www.linkedin.com/jobs/view/77"]
    st = store.status(tmp_path, jid)
    assert st["status"] == "FAILED" and "logged in" in st["history"][-1]["detail"]
    store.set_status(tmp_path, jid, "NEW")  # Try again
    monkeypatch.setattr(accounts, "page_text", lambda d, url: "Data Analyst at Acme. " * 20)
    assert fetch.fetch(tmp_path, jid)["ok"] and "Data Analyst at Acme." in (store.jdir(tmp_path, jid) / "posting.md").read_text("utf-8")


def test_auto_login_waits_after_a_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts, "saved", lambda site: {"user": "u", "pass": "p"})
    accounts._remember(tmp_path, "linkedin", ok=False)
    assert accounts._auto_login(tmp_path, None, "linkedin") is False  # ctx is never touched
    old = (datetime.now(timezone.utc) - timedelta(hours=accounts.RETRY_HOURS + 1)).isoformat()
    store.atomic_write_json(tmp_path / "logins.json", {"linkedin": {"at": old, "ok": False}})

    class Page:
        def goto(self, *a, **k):
            raise RuntimeError("offline")

        def close(self):
            pass

    class Ctx:  # past the wait it tries again
        def new_page(self):
            return Page()

    assert accounts._auto_login(tmp_path, Ctx(), "linkedin") is False
    assert (store._load(tmp_path / "logins.json"))["linkedin"]["at"] != old
    monkeypatch.setattr(accounts, "saved", lambda site: None)
    assert accounts._auto_login(tmp_path, None, "indeed") is False  # nothing saved: no attempt


def test_login_cli_shapes(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(accounts, "status", lambda d: {"linkedin": {"logged_in": True, "saved": False}})
    assert cli.main(["--data-dir", str(tmp_path), "login", "status"]) == 0
    assert '"logged_in": true' in capsys.readouterr().out
    monkeypatch.setattr(accounts, "_ask", lambda name: (None, None))
    assert cli.main(["--data-dir", str(tmp_path), "credentials", "set", "indeed"]) == 1
    assert '"cancelled"' in capsys.readouterr().out


def test_indeed_links_use_the_app_api_then_the_browser(tmp_path, monkeypatch):
    jid = store.new_job(tmp_path, "https://www.indeed.com/jobs?q=analyst&vjk=72ec85f03f607d5c")["job_id"]
    monkeypatch.setattr(fetch, "_indeed", lambda url: "# Analyst\nCompany: Acme\n\n" + "Build dashboards. " * 20)
    monkeypatch.setattr(accounts, "page_text", lambda d, url: pytest.fail("the API answered"))
    assert fetch.fetch(tmp_path, jid)["ok"]
    jid2 = store.new_job(tmp_path, "https://www.indeed.com/viewjob?jk=0000000000000001")["job_id"]
    monkeypatch.setattr(fetch, "_indeed", lambda url: None)
    monkeypatch.setattr(accounts, "page_text", lambda d, url: "From the browser. " * 20)
    assert fetch.fetch(tmp_path, jid2)["ok"] and "From the browser." in (store.jdir(tmp_path, jid2) / "posting.md").read_text("utf-8")
