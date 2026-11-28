"""Lever and Ashby: detection, ids, posting text, form scan and dry fill against saved fixture pages served at the real URLs
(no network, no live form). The fixtures have submit and Enter-key spies; neither may ever fire."""
import json

import httpx
import pytest

from jobagent import browser, canary, cli, fetch, fill, store
from jobagent.ats import detect
from jobagent.ats.ashby import Ashby
from jobagent.ats.base import Closed
from jobagent.ats.formscan import as_fields
from jobagent.ats.lever import Lever
from test_jobs import FX

LV_ID, AB_ID = "2f3c9a1e-5b6d-4c7e-8f90-1a2b3c4d5e6f", "7d1e2f3a-4b5c-4d6e-9f70-8a9b0c1d2e3f"
LV_URL, AB_URL = f"https://jobs.lever.co/acme/{LV_ID}", f"https://jobs.ashbyhq.com/acme/{AB_ID}"
LEVER, ASHBY = (FX / "lever_form.html").read_text("utf-8"), (FX / "ashby_form.html").read_text("utf-8")
CARD = f"cards[{canary.LV}]"


@pytest.fixture(autouse=True)
def _dry(monkeypatch):
    monkeypatch.setenv("JOBAGENT_DRY_RUN", "1")


def fake_get(monkeypatch, routes: dict):
    def get(url, **kw):
        hit = next((v for k, v in routes.items() if k in url), None)
        return httpx.Response(404 if hit is None else 200, json=hit if hit is not None else {"ok": False}, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", get)


# ---- detection and ids -----------------------------------------------------------------------------

def test_detect_and_ids():
    assert detect.from_url(f"{LV_URL}/apply?lever-source=LinkedIn") == {"ats": "lever", "board": "acme", "posting_id": LV_ID}
    assert detect.from_url(f"https://jobs.eu.lever.co/Acme/{LV_ID.upper()}")["eu"] is True
    assert detect.from_url(f"{AB_URL}/application?utm_source=x") == {"ats": "ashby", "board": "acme", "posting_id": AB_ID}
    assert detect.from_url("https://jobs.lever.co/acme") == {"ats": "generic"}  # the board, not a posting
    assert detect.from_url("https://jobs.ashbyhq.com/acme/not-a-uuid") == {"ats": "generic"}
    for u, jid in ((f"{LV_URL}/apply", f"lever-acme-{LV_ID}"), (f"{AB_URL}/application", f"ashby-acme-{AB_ID}")):
        assert store.canonical_url(u) == u.rsplit("/", 1)[0] and store.job_id_for(store.canonical_url(u)) == jid
    eu = store.canonical_url(f"https://jobs.eu.lever.co/acme/{LV_ID}/apply")
    assert eu == f"https://jobs.eu.lever.co/acme/{LV_ID}" and Lever.apply_url(detect.from_url(eu)).startswith("https://jobs.eu.lever.co/")
    page = f'<script src="https://jobs.ashbyhq.com/acme/embed?version=2"></script>'
    assert detect.from_html(f"https://acme.com/careers?ashby_jid={AB_ID}", page)["ats"] == "ashby"
    assert detect.from_html("https://acme.com/careers?ashby_jid=1", page) == {"ats": "generic"}
    links = f'<a href="{LV_URL}/apply">Apply</a> <a href="{LV_URL}">again</a> <a href="https://job-boards.greenhouse.io/acme/jobs/9">x</a>'
    assert [g["ats"] for g in detect.postings_in(links)] == ["lever", "greenhouse"]
    assert isinstance(detect.adapter_for(detect.from_url(LV_URL)), Lever) and isinstance(detect.adapter_for(detect.from_url(AB_URL)), Ashby)


# ---- posting text ----------------------------------------------------------------------------------

def test_lever_posting_text_and_closed(tmp_path, monkeypatch):
    fake_get(monkeypatch, {f"api.lever.co/v0/postings/acme/{LV_ID}": json.loads((FX / "lever_posting.json").read_text("utf-8"))})
    jid = store.new_job(tmp_path, LV_URL)["job_id"]
    assert fetch.fetch(tmp_path, jid)["ok"]
    text = (store.jdir(tmp_path, jid) / "posting.md").read_text("utf-8")
    assert "# Data Analyst" in text and "Location: Austin, TX (remote)" in text and "Pay: USD 95000 - 125000 (per year salary)" in text
    assert "Build dbt models" in text and text.startswith("Content below is from a third-party website")  # wrapped as untrusted
    fake_get(monkeypatch, {})
    gone = store.new_job(tmp_path, f"https://jobs.lever.co/acme/{LV_ID[:-1]}0")["job_id"]
    assert fetch.fetch(tmp_path, gone)["code"] == "closed" and store.status(tmp_path, gone)["status"] == "CLOSED"


def test_ashby_posting_text_unlisted_and_missing_board(monkeypatch):
    fake_get(monkeypatch, {"posting-api/job-board/acme": json.loads((FX / "ashby_board.json").read_text("utf-8"))})
    a = Ashby()
    text = a.posting_text(detect.from_url(AB_URL))
    assert "Location: Austin (Remote)" in text and "Pay: $110K – $140K" in text and "We need a Data Analyst." in text
    assert a.posting_text(detect.from_url("https://jobs.ashbyhq.com/acme/9f3a4b5c-6d7e-4f80-9a01-0b1c2d3e4f5a")) is None  # unlisted: render the page
    with pytest.raises(Closed):
        a.posting_text(detect.from_url(AB_URL.replace("/acme/", "/nobody/")))


# ---- form scan and dry fill ------------------------------------------------------------------------

def test_lever_scan_shape(tmp_path):
    with browser.session(tmp_path, ["lever.co"]) as ctx:
        canary.serve(ctx, f"{LV_URL}/apply", LEVER, [])
        pg = ctx.new_page()
        pg.goto(f"{LV_URL}/apply")
        f = {x["fid"]: x for x in as_fields(Lever().scan(pg))}  # the fields.json shape (scan adds filled and group)
    assert set(f) >= {"resume", "name", "email", "phone", "urls[LinkedIn]", f"{CARD}[field0]", f"{CARD}[field1]", "eeo[gender]", "comments"}
    assert not any("baseTemplate" in k or k in ("accountId", "selectedLocation") for k in f)  # hidden inputs are not questions
    assert f["resume"]["type"] == "file" and f["resume"]["required"] and f["resume"]["label"] == "Resume/CV"
    assert f[f"{CARD}[field0]"] | {"selector": None} == {"fid": f"{CARD}[field0]", "label": "Are you legally authorized to work in the United States?",
                                                         "type": "select", "required": True, "options": ["Yes", "No"], "selector": None, "section": "main"}
    assert f[f"{CARD}[field1]"]["type"] == "multiselect" and f[f"{CARD}[field1]"]["options"] == ["SQL", "dbt", "Python"]
    assert f[f"{CARD}[field3]"]["options"] == ["LinkedIn", "A friend"]  # the "Select..." placeholder is not an option
    assert f["eeo[gender]"]["section"] == "demographic" and not f["phone"]["required"]


def test_lever_dry_fill_puts_values_in_the_page_and_never_submits(tmp_path):
    ev = []
    jid, hook = canary.prepared(tmp_path, "lever", ev)
    j, m = store.jdir(tmp_path, jid), store.meta(tmp_path, jid)
    res = fill.fill_job(tmp_path, jid, True, prepare=hook)
    assert res["ok"], res
    assert res["filled"] == 11 and ev == [] and store.status(tmp_path, jid)["status"] == "FILLED_DRY"
    assert "Jane" not in (j / "fill_report.json").read_text("utf-8")  # no values in reports
    fields = {f["fid"]: f for f in json.loads((j / "fields.json").read_text())}
    ad = Lever()
    with browser.session(tmp_path, ad.allowed_hosts(m)) as ctx:
        hook(ctx)
        pg = ctx.new_page()
        pg.goto(ad.apply_url(m))
        rep = ad.fill(pg, canary.CASES["lever"]["plan"], fields, j)
        assert rep["errors"] == [] and pg.input_value("[name=name]") == "Jane Doe"  # typed after the resume parser re-filled it
        assert pg.is_checked(f'[name="{CARD}[field0]"][value=Yes]') and not pg.is_checked(f'[name="{CARD}[field0]"][value=No]')
        assert [pg.is_checked(f'[name="{CARD}[field1]"][value="{v}"]') for v in ("SQL", "dbt", "Python")] == [True, False, True]
        assert pg.input_value('[name="eeo[gender]"]') == "Decline to self-identify"
        assert pg.evaluate("document.querySelector('#resume-upload-input').files.length") == 1
        assert pg.evaluate("(window.__submitted || 0) + (window.__enter || 0)") == 0


def test_ashby_dry_fill_buttons_hidden_radios_and_combobox(tmp_path):
    ev = []
    jid, hook = canary.prepared(tmp_path, "ashby", ev)
    j, m = store.jdir(tmp_path, jid), store.meta(tmp_path, jid)
    fields = {f["fid"]: f for f in json.loads((j / "fields.json").read_text())}
    assert fields["choice-4"]["options"] == ["Yes", "No"] and fields["choice-4"]["required"]  # a Yes/No question made of buttons
    assert fields[f"{canary.AB}4"]["section"] == "demographic"  # under the EEO heading
    assert fields["_systemfield_location"]["required"] and fields["_systemfield_location"]["type"] == "select"  # a box with no name or id
    assert fill.fill_job(tmp_path, jid, True, prepare=hook)["ok"] and ev == []
    ad = Ashby()
    with browser.session(tmp_path, ad.allowed_hosts(m)) as ctx:
        hook(ctx)
        pg = ctx.new_page()
        pg.goto(ad.apply_url(m))
        pg.wait_for_selector(".ashby-application-form-container input")
        assert {"_systemfield_location", "choice-4"} <= {x["fid"] for x in ad.empty_required(pg, fields)}  # unanswered ones are noticed
        assert ad.fill(pg, canary.CASES["ashby"]["plan"], fields, j)["errors"] == []
        assert pg.get_attribute("._yesno button:text-is('No')", "aria-pressed") == "true"
        assert pg.is_checked(f'[name="{canary.AB}2"][value=b]')  # hidden radio, picked through its label
        assert pg.input_value("[role=combobox]") == "Austin, Texas, United States"  # "Austin, TX": not the Minnesota one above it
        assert not {"_systemfield_location", "choice-4"} & {x["fid"] for x in ad.empty_required(pg, fields)}
        assert pg.evaluate("(window.__submitted || 0) + (window.__enter || 0)") == 0
        bad = [{"fid": "choice-4", "action": "select", "value": "Submit"}]  # never a button that is not one of the question's own
        assert ad.fill(pg, bad, fields, j)["errors"] == [{"fid": "choice-4", "error": "Unexpected"}]
        assert pg.evaluate("window.__submitted || 0") == 0


def test_untyped_button_inside_a_form_is_never_a_choice(tmp_path):
    box = '<div class="ashby-application-form-field-entry"><label>Ready?</label><button>Yes</button><button>No</button></div>'
    with browser.session(tmp_path, ["ashbyhq.com"]) as ctx:
        pg = ctx.new_page()
        pg.set_content(f'<div class="ashby-application-form-container"><form>{box}</form></div>')
        assert Ashby().scan(pg) == []  # it would submit the form
        pg.set_content(f'<div class="ashby-application-form-container">{box}</div>')
        assert [r["options"] for r in Ashby().scan(pg)] == [["Yes", "No"]]


def test_follow_up_question_that_appears_is_reported(tmp_path):
    plan = [p if p["fid"] != "choice-4" else {**p, "value": "Yes"} for p in canary.CASES["ashby"]["plan"]]
    jid, hook = canary.prepared(tmp_path, "ashby", [], plan=plan)
    res = fill.fill_job(tmp_path, jid, True, prepare=hook)
    assert res["code"] == "needs_human" and len(res["empty_required"]) == 1 and "visa" in res["empty_required"][0].lower()  # "Which visa?" appeared after "Yes"
    assert "visa" in store.status(tmp_path, jid)["history"][-1]["detail"].lower()  # named on the card, not "the form didn't match"


def test_value_the_page_did_not_keep_is_an_error(tmp_path):
    page = LEVER.replace('<input type="text" name="name" required>', '<input type="text" name="name" maxlength="3" required>')
    jid, hook = canary.prepared(tmp_path, "lever", [], html=page)
    res = fill.fill_job(tmp_path, jid, True, prepare=hook)
    assert res["code"] == "plan_mismatch" and res["errors"] == [{"fid": "name", "error": "value_not_kept"}]


def test_blockers_and_closed_pages(tmp_path, monkeypatch):
    monkeypatch.setattr(Lever, "WAIT", 500)
    monkeypatch.setattr(Ashby, "WAIT", 500)
    page = LEVER.replace('data-size="invisible"', 'style="width:300px;height:80px"')  # a visible hCaptcha
    jid, hook = canary.prepared(tmp_path / "a", "lever", [])
    res = fill.fill_job(tmp_path / "a", jid, True, prepare=lambda c: canary.serve(c, Lever.apply_url(store.meta(tmp_path / "a", jid)), page, []))
    assert res["reason"] == "captcha" and store.status(tmp_path / "a", jid)["status"] == "NEEDS_HUMAN"
    d = tmp_path / "b"
    jid = store.new_job(d, LV_URL)["job_id"]
    gone = "<html><body><h1>Sorry, this job is no longer available.</h1></body></html>"
    res = fetch.inspect_job(d, jid, prepare=lambda c: canary.serve(c, f"{LV_URL}/apply", gone, []))
    assert res["code"] == "closed" and store.status(d, jid)["status"] == "CLOSED"
    jid = store.new_job(d, AB_URL)["job_id"]
    res = fetch.inspect_job(d, jid, prepare=lambda c: canary.serve(c, f"{AB_URL}/application", "<html><body><p>Loading</p></body></html>", []))
    assert res["code"] == "inspect_failed"


# ---- canary ----------------------------------------------------------------------------------------

def test_canary_passes_on_the_recorded_forms(tmp_path, capsys):
    assert cli.main(["--data-dir", str(tmp_path), "canary"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out == {"ok": True, "checked": ["greenhouse", "lever", "ashby", "breezy", "recruitee", "rippling"], "failures": []}
    assert not (tmp_path / "jobs").exists()  # runs in a throwaway folder, never the user's data


def test_canary_reports_a_broken_adapter(tmp_path, monkeypatch):
    monkeypatch.setattr(Lever, "ROOTS", ["#gone"])  # the page changed: the form is not where the adapter looks
    monkeypatch.setattr(Lever, "WAIT", 500)
    assert canary._case(tmp_path, "lever").startswith("Unexpected")
    monkeypatch.setitem(canary.CASES["ashby"], "plan", [*canary.CASES["ashby"]["plan"][:-1], {"fid": f"{canary.AB}4", "action": "select", "value": "Nope", "source": "user"}])
    assert canary._case(tmp_path, "ashby").startswith("JobError: select values must be one of the field's options")


def test_select_values_are_matched_to_the_pages_own_options():
    from jobagent.ats.base import match_option

    fields = {"q": {"fid": "q", "options": ["Yes", "No"]}, "loc": {"fid": "loc", "options": []}}
    assert match_option(["Yes", "No"], " yes ") == "Yes" and match_option(["Decline to self-identify"], "decline to  SELF-identify") == "Decline to self-identify"
    assert fill.check_plan({"fields": [{"fid": "q", "action": "select", "value": "YES"}, {"fid": "loc", "action": "select", "value": "Austin"}]}, fields)
    with pytest.raises(store.JobError) as e:  # caught before any browser opens, with the field named
        fill.check_plan({"fields": [{"fid": "q", "action": "select", "value": ["Yes", "Maybe"]}]}, fields)
    assert e.value.code == "bad_plan" and "q" in str(e.value)
