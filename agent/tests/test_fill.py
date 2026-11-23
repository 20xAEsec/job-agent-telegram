"""Stage d: dry fill against SAVED fixture HTML served at the real Greenhouse URL (no network, no live form).
The fixture's form has an onsubmit spy and an Enter-key spy; neither may ever fire."""
import json

import pytest

from jobagent import browser, fill, store
from jobagent.ats.greenhouse import Greenhouse
from test_jobs import FX, JID, URL, mkjob  # noqa: F401  (helpers shared with the other stage d tests)

FORM = (FX / "gh_form.html").read_text("utf-8")


@pytest.fixture(autouse=True)
def _dry(monkeypatch):
    monkeypatch.setenv("JOBAGENT_DRY_RUN", "1")


def serve(ctx, html=FORM, seen=None, spy=None):
    """Route the Greenhouse URL to a saved page and record every request (spy hits and non-GET methods)."""
    ctx.route(URL, lambda r: r.fulfill(status=200, content_type="text/html", body=html))
    ctx.route("**/__spy*", lambda r: (spy.append(r.request.url) if spy is not None else None, r.fulfill(status=204)))
    if seen is not None:
        ctx.on("request", lambda r: seen.append((r.method, r.url)))


def test_dry_fill_fills_every_field_and_never_submits(tmp_path):
    jid = mkjob(tmp_path)
    spy, seen = [], []
    res = fill.fill_job(tmp_path, jid, True, prepare=lambda c: serve(c, seen=seen, spy=spy))
    assert res["ok"], res
    assert res["filled"] == 11 and res["extra_on_page"] == []
    assert spy == [] and all(m == "GET" for m, _ in seen)  # onsubmit/Enter spies silent, no POST ever left the page
    assert store.status(tmp_path, jid)["status"] == "FILLED_DRY"
    rep = json.loads((store.jdir(tmp_path, jid) / "fill_report.json").read_text())
    assert rep["errors"] == [] and rep["missing_on_page"] == [] and "Jane" not in json.dumps(rep)  # no field values in reports
    assert (store.jdir(tmp_path, jid) / "screenshots" / "filled.png").stat().st_size > 1000


def test_adapter_fill_puts_values_in_the_page_without_enter_or_submit(tmp_path):
    jid = mkjob(tmp_path)
    j, m = store.jdir(tmp_path, jid), store.meta(tmp_path, jid)
    fields = {f["fid"]: f for f in json.loads((j / "fields.json").read_text())}
    plan = json.loads((j / "plan.json").read_text())["fields"]
    ad = Greenhouse()
    with browser.session(tmp_path, ad.allowed_hosts(m)) as ctx:
        serve(ctx)
        pg = ctx.new_page()
        pg.goto(ad.apply_url(m))
        assert ad.detect_blockers(pg) is None  # the invisible reCAPTCHA badge is not a blocker
        rep = ad.fill(pg, plan, fields, j)
        assert rep["errors"] == [] and len(rep["filled"]) == 11
        assert pg.input_value("#first_name") == "Jane" and pg.input_value("#question_103") == "I like widgets."
        assert pg.input_value("#question_104") == "they/them"
        assert pg.locator("#question_101 >> xpath=ancestor::*[contains(@class,'select__control')]").inner_text().strip() == "Yes"
        assert pg.locator("#gender >> xpath=ancestor::*[contains(@class,'select__control')]").inner_text().strip() == "Decline To Self Identify"
        assert pg.evaluate("document.querySelector('#resume').files.length") == 1
        assert pg.evaluate("window.__submitted || 0") == 0 and pg.evaluate("window.__enter || 0") == 0


def test_captcha_page_needs_human(tmp_path):
    jid = mkjob(tmp_path)
    page = FORM.replace("</form>", '<div class="g-recaptcha" data-sitekey="k" style="width:304px;height:78px"></div></form>')
    res = fill.fill_job(tmp_path, jid, True, prepare=lambda c: serve(c, page))
    assert res["code"] == "needs_human" and res["reason"] == "captcha"
    assert store.status(tmp_path, jid)["status"] == "NEEDS_HUMAN"


def test_login_wall_needs_human(tmp_path):
    jid = mkjob(tmp_path)
    page = FORM.replace("</form>", '<input type="password" id="pw"></form>')
    res = fill.fill_job(tmp_path, jid, True, prepare=lambda c: serve(c, page))
    assert res["reason"] == "login" and store.status(tmp_path, jid)["status"] == "NEEDS_HUMAN"


def test_off_domain_redirect_is_blocked_and_needs_human(tmp_path):
    jid = mkjob(tmp_path)
    hit = []
    def prepare(ctx):
        ctx.route("https://evil.example/**", lambda r: (hit.append(r.request.url), r.fulfill(status=200, body="x")))
        ctx.route(URL, lambda r: r.fulfill(status=302, headers={"location": "https://evil.example/phish"}))
    res = fill.fill_job(tmp_path, jid, True, prepare=prepare)
    assert res["code"] == "needs_human" and store.status(tmp_path, jid)["status"] == "NEEDS_HUMAN"
    assert hit == []  # the guard aborted the navigation before the page loaded


def test_plan_page_mismatch_is_reported_not_guessed(tmp_path):
    jid = mkjob(tmp_path)
    j = store.jdir(tmp_path, jid)
    plan = json.loads((j / "plan.json").read_text())
    plan["fields"] = [f for f in plan["fields"] if f["fid"] != "question_102"]  # required sponsorship question left unplanned
    (j / "plan.json").write_text(json.dumps(plan))
    res = fill.fill_job(tmp_path, jid, True, prepare=serve)
    assert res["code"] == "plan_mismatch" and res["unplanned_required"] == ["question_102"]
    assert store.status(tmp_path, jid)["status"] == "READY"  # back to classification
    page = FORM.replace('<input id="question_100" type="text">', "")  # a planned field the page lacks
    mkjob(tmp_path / "b")
    res = fill.fill_job(tmp_path / "b", JID, True, prepare=lambda c: serve(c, page))
    assert res["code"] == "plan_mismatch" and res["missing_on_page"] == ["question_100"]
    page = FORM.replace("</form>", '<input id="surprise" required type="text"></form>')  # a required control the API never listed
    res = fill.fill_job(tmp_path / "b", JID, True, prepare=lambda c: serve(c, page))
    assert "surprise" in res["unplanned_required"]


def test_fill_needs_ready_status_and_a_valid_plan(tmp_path):
    jid = mkjob(tmp_path, "FILLED_DRY")
    with pytest.raises(store.JobError) as e:
        fill.fill_job(tmp_path, jid, True)
    assert e.value.code == "bad_status"
    b = mkjob(tmp_path / "b")
    (store.jdir(tmp_path / "b", b) / "plan.json").write_text(json.dumps({"fields": [{"fid": "nope", "action": "fill", "value": "x"}]}))
    with pytest.raises(store.JobError) as e:
        fill.fill_job(tmp_path / "b", b, True)
    assert e.value.code == "bad_plan"
