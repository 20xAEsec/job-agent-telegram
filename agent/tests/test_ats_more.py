"""Breezy, Recruitee, Rippling and the form-engine behaviors they needed (4.1): detection, scan, dry fill against recorded pages
served at the real URLs (no network, no live form). The fixtures have submit and Enter-key spies; neither may ever fire."""
import json

import pytest

from jobagent import browser, canary, fill, formplan, llm, store
from jobagent.ats import detect
from jobagent.ats.base import iso_date
from jobagent.ats.formscan import as_fields
from jobagent.ats.more import Breezy, Recruitee, Rippling
from test_jobs import FX

SPIES = "(window.__submitted || 0) + (window.__enter || 0)"


@pytest.fixture(autouse=True)
def _dry(monkeypatch):
    monkeypatch.setenv("JOBAGENT_DRY_RUN", "1")


def test_detect_ids_and_canonical():
    assert detect.from_url("https://acme.breezy.hr/p/1a2b3c4d5e6f-data-analyst/apply") == {"ats": "breezy", "board": "acme", "posting_id": "1a2b3c4d5e6f"}
    assert detect.from_url("https://acme.recruitee.com/o/data-analyst/c/new") == {"ats": "recruitee", "board": "acme", "posting_id": "data-analyst"}
    rp = f"https://ats.rippling.com/en-GB/Acme/jobs/{canary.RP}/apply?step=application"
    assert detect.from_url(rp) == {"ats": "rippling", "board": "acme", "posting_id": canary.RP}
    assert store.canonical_url(rp) == f"https://ats.rippling.com/acme/jobs/{canary.RP}"
    assert store.job_id_for(store.canonical_url("https://acme.breezy.hr/p/1a2b3c4d5e6f-x")) == "breezy-acme-1a2b3c4d5e6f"
    for u in ("https://acme.breezy.hr/", "https://app.breezy.hr/p/1a2b3c4d5e6f", "https://acme.recruitee.com/", "https://www.recruitee.com/o/x",
              "https://ats.rippling.com/acme/jobs", "https://careers.acme.com/o/data-analyst"):
        assert detect.from_url(u) == {"ats": "generic"}, u
    page = f'<a href="https://acme.breezy.hr/p/1a2b3c4d5e6f-x">Apply</a> <a href="https://ats.rippling.com/acme/jobs/{canary.RP}">x</a>'
    assert [g["ats"] for g in detect.postings_in(page)] == ["breezy", "rippling"]
    for name, cls in (("breezy", Breezy), ("recruitee", Recruitee), ("rippling", Rippling)):
        g = detect.from_url(canary.CASES[name]["url"])
        assert isinstance(detect.adapter_for(g), cls) and detect.from_url(detect.canonical(g)) == g


def _scan(tmp_path, name, html=None):
    c, m = canary.CASES[name], detect.from_url(canary.CASES[name]["url"])
    ad, page = detect.adapter_for(m), html or (FX / c["form"]).read_text("utf-8")
    return {f["fid"]: f for f in ad.inspect(m, tmp_path, lambda ctx: canary.serve(ctx, ad.apply_url(m), page, []))}


def test_breezy_scan_reads_headings_and_skips_the_honeypot(tmp_path):
    f = _scan(tmp_path, "breezy")
    assert "hp_7f2b" not in f  # a bot trap: filling it marks the application as spam
    assert f["cName"]["label"] == "Full Name" and f["cName"]["required"] and f["cSummary"]["label"] == "Experience Summary"
    assert f["cSummary"]["max_chars"] == 500 and "max_chars" not in f["cCoverLetter"]
    assert f["q_auth"] | {"selector": None} == {"fid": "q_auth", "label": "Are you legally authorized to work in the United States?", "type": "select",
                                                 "required": True, "options": ["Yes", "No"], "selector": None, "section": "main"}
    assert f["q_start"]["type"] == "date" and f["q_start"]["label"] == "Earliest start date"
    assert f["smsConsent"]["type"] == "checkbox" and f["smsConsent"]["label"].startswith("By providing your phone number")
    assert f["cResume"]["type"] == "file"


def test_recruitee_scan_section_fieldsets_name_no_question(tmp_path):
    f = _scan(tmp_path, "recruitee")
    assert f["candidate.name"]["label"] == "Full name" and f["candidate.phone"]["label"] == "Phone number"  # not "My information"
    q = f["candidate.openQuestionAnswers.101.flag"]
    assert q["label"].startswith("Do you have the right to work") and q["options"] == ["Yes", "No"] and q["required"]
    assert f["candidate.locations.value"]["type"] == "multiselect" and f["candidate.locations.value"]["options"] == ["Amsterdam", "Cologne"]
    assert f["candidate.openQuestionAnswers.102.content"]["max_chars"] == 40
    assert f["cc1"]["type"] == "select" and "calling code" in f["cc1"]["label"]  # a dropdown drawn as a button
    assert f["candidate.textingConsent"]["label"] == "I consent to be contacted via text messages."
    assert f["candidate.cv"]["required"] and f["candidate.cv"]["type"] == "file"


def test_rippling_keys_survive_reloads_and_drawn_controls_are_read(tmp_path):
    a, b = _scan(tmp_path / "a", "rippling"), _scan(tmp_path / "b", "rippling")
    assert set(a) == set(b)  # the page's names are new on every load: the keys come from its test ids
    assert {"input-resume", "input-first_name", "input-email", "input-phone_number", "input-undefined", "eeoc.gender", "sms_opt_in", "pronouns_strategy"} <= set(a)
    assert a["input-resume"]["label"] == "Résumé" and a["input-resume"]["required"]  # the star beside the label
    assert a["input-phone_number"]["label"] == "Phone number" and a["input-undefined"]["label"] == "Location"
    assert a["eeoc.gender"]["options"] == ["Female", "Male", "Decline to self-identify"] and a["eeoc.gender"]["section"] == "demographic"
    assert a["sms_opt_in"]["options"] == ["Yes - I consent to receiving text messages", "No - I do not consent to receiving text messages"]
    assert a["sms_opt_in"]["label"].startswith("Check Yes or No")


@pytest.mark.parametrize("name", ["breezy", "recruitee", "rippling"])
def test_dry_fill_never_submits(tmp_path, name):
    ev = []
    jid, hook = canary.prepared(tmp_path, name, ev)
    res = fill.fill_job(tmp_path, jid, True, prepare=hook)
    assert res["ok"], res
    assert ev == [] and store.status(tmp_path, jid)["status"] == "FILLED_DRY"


def test_rippling_values_land_in_the_drawn_controls(tmp_path):
    jid, hook = canary.prepared(tmp_path, "rippling", [])
    j, m = store.jdir(tmp_path, jid), store.meta(tmp_path, jid)
    fields = {f["fid"]: f for f in json.loads((j / "fields.json").read_text("utf-8"))}
    ad = Rippling()
    with browser.session(tmp_path, ad.allowed_hosts(m)) as ctx:
        hook(ctx)
        pg = ctx.new_page()
        pg.goto(ad.apply_url(m))
        pg.wait_for_selector("form input", state="attached")
        assert ad.fill(pg, canary.CASES["rippling"]["plan"], fields, j)["errors"] == []
        assert pg.input_value("#f42") == "Austin, TX, USA" and pg.input_value("#place-id") == "p1"  # picked from the suggestions
        assert pg.inner_text("#f55") == "Decline to self-identify"
        assert pg.get_attribute('[aria-labelledby="l84"]', "aria-checked") == "true"
        assert pg.evaluate("document.querySelector('[data-testid=input-resume]').files.length") == 1
        assert pg.evaluate(SPIES) == 0


def test_recruitee_with_its_captcha_is_read_and_left_for_the_user(tmp_path):
    cap = '<iframe title="Widget containing checkbox for hCaptcha security challenge" src="about:blank" style="width:300px;height:80px"></iframe>'
    page = (FX / "recruitee_form.html").read_text("utf-8").replace('<div id="captcha-slot"></div>', cap)
    assert "candidate.cv" in _scan(tmp_path / "a", "recruitee", page)  # the form is still readable
    m = detect.from_url(canary.CASES["recruitee"]["url"])
    jid, _ = canary.prepared(tmp_path / "b", "recruitee", [])
    res = fill.fill_job(tmp_path / "b", jid, True, prepare=lambda c: canary.serve(c, Recruitee.apply_url(m), page, []))
    assert res["reason"] == "captcha" and store.status(tmp_path / "b", jid)["status"] == "NEEDS_HUMAN"


def test_bot_walls_count_as_human_checks(tmp_path):
    m = detect.from_url(canary.CASES["breezy"]["url"])
    wall = '<html><body><iframe src="https://geo.captcha-delivery.com/captcha/?x=1" style="width:400px;height:400px"></iframe></body></html>'
    jid, _ = canary.prepared(tmp_path, "breezy", [])
    res = fill.fill_job(tmp_path, jid, True, prepare=lambda c: (canary.serve(c, Breezy.apply_url(m), wall, []),
                                                                 c.route("https://geo.captcha-delivery.com/**", lambda r: r.fulfill(body=""))))
    assert res["reason"] == "captcha"


def test_dates_and_box_limits_in_the_plan():
    assert [iso_date(v) for v in ("2026-12-01", "12/01/2026", "December 1, 2026", "Dec 2026", "2026")] == ["2026-12-01"] * 3 + ["2026-12-01", "2026-01-01"]
    assert iso_date("2026-12-01", "month") == "2026-12" and iso_date("soon") is None
    assert formplan._row({"fid": "d", "type": "date"}, "March 3, 2026", "user")["value"] == "2026-03-03"
    assert formplan._row({"fid": "t", "type": "text", "max_chars": 5}, "abcdefgh", "user")["value"] == "abcde"
    assert llm._value("t", {"type": "textarea", "max_chars": 10}, "x" * 11, {})[1] == ["t: the value must be text of 1 to 10 characters"]
    assert llm._value("d", {"type": "date"}, "next week", {})[1] and llm._value("d", {"type": "date"}, "12/01/2026", {}) == ("2026-12-01", [])
    assert llm.question_for({"fid": "d", "type": "month", "label": "Start"}, None, False, None)["kind"] == "date"


def test_scan_rows_keep_the_fields_json_shape(tmp_path):
    with browser.session(tmp_path, ["breezy.hr"]) as ctx:
        pg = ctx.new_page()
        pg.set_content('<form name="form"><h3>Age</h3><input name="age" maxlength="3"></form>')
        assert as_fields(Breezy().scan(pg)) == [{"fid": "age", "label": "Age", "type": "text", "required": False, "options": [],
                                                  "selector": '[name="age"]', "section": "main", "max_chars": 3}]
