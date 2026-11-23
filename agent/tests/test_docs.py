"""Stage c: resume tailoring. Fixtures are built here with dummy data (no personal files)."""
import json

import docx
import pymupdf
import pytest

from jobagent import cli, tailor
from jobagent.docs import docx_tailor, pdf_tailor, render
from jobagent.docs.plan import DocError

needs_converter = pytest.mark.skipif(not render.has_converter(), reason="no DOCX->PDF converter (Word or LibreOffice)")

BULLETS = [
    "Built dashboards in SQL and dbt that cut weekly reporting time by a third across four teams.",
    "Automated data quality checks for 40 pipelines using Python, saving about six hours every week.",
    "Partnered with finance to define revenue metrics and publish them in a shared semantic layer.",
    "Mentored three junior analysts on query tuning, code review and clear written communication.",
    "Migrated legacy spreadsheets into a warehouse model with tests, lineage and owners for each table.",
    "Presented quarterly findings to executives and turned them into a prioritised analytics roadmap.",
]


def make_docx(path):
    d = docx.Document()

    def h(t):
        d.add_paragraph().add_run(t).bold = True

    h("JANE DOE")
    d.add_paragraph("Springfield  |  jane@example.com")
    h("SUMMARY")
    d.add_paragraph("Data analyst with five years of experience turning messy data into decisions for product teams.")
    h("SKILLS")
    for lab, rest in [("Languages: ", "Python, SQL, R"), ("Tools: ", "dbt, Airflow, Tableau")]:
        p = d.add_paragraph()
        p.add_run(lab).bold = True
        p.add_run(rest)
    h("EXPERIENCE")
    d.add_paragraph("Acme Corp, Data Analyst, 2020 to 2025")
    for b in BULLETS:
        p = d.add_paragraph(style="List Bullet")
        p.add_run(b[:20])
        p.add_run(b[20:])  # two runs: only the first run's formatting must survive
    d.save(path)


def make_pdf(path, serif=False):
    doc = pymupdf.open()
    page = doc.new_page()
    f, fb = ("tiro", "tibo") if serif else ("helv", "hebo")
    page.insert_text((50, 60), "JANE DOE", fontname=fb, fontsize=16)
    page.insert_text((50, 110), "SUMMARY", fontname=fb, fontsize=11)
    page.insert_textbox(pymupdf.Rect(50, 120, 540, 160), "Data analyst with five years of experience turning messy data into decisions for product teams, with a focus on clear metrics.", fontname=f, fontsize=10)
    page.insert_text((50, 190), "EXPERIENCE", fontname=fb, fontsize=11)
    y = 200
    for b in BULLETS:
        page.insert_textbox(pymupdf.Rect(50, y, 540, y + 30), "- " + b, fontname=f, fontsize=10)
        y += 36
    doc.save(path)


def pdf_text(p):
    with pymupdf.open(p) as d:
        return " ".join(x.get_text() for x in d)


def five_edits(units):
    bullets = [u for u in units if u["kind"] == "bullet"][:5]
    return {"edits": [{"uid": u["uid"], "new_text": u["text"].replace("Built", "Built and shipped")[: u["max_chars"]], "reason": "t"} for u in bullets]}


# ---- pure tests (no converter) -------------------------------------------------------

def test_docx_outline_kinds_and_label_run(tmp_path):
    make_docx(tmp_path / "a.docx")
    u = {x["text"][:9]: x for x in docx_tailor.outline(tmp_path / "a.docx")}
    assert u["JANE DOE"]["kind"] == "heading" and u["Springfie"]["kind"] == "other"
    assert u["Data anal"]["kind"] == "summary"
    assert u["Python, S"]["kind"] == "skills" and u["Python, S"]["text"] == "Python, SQL, R"  # label run is not part of the unit
    assert u["Built das"]["kind"] == "bullet"
    assert u["Built das"]["max_chars"] == u["Built das"]["char_len"]
    mod = {x["text"][:9]: x for x in docx_tailor.outline(tmp_path / "a.docx", "moderate")}
    assert mod["Data anal"]["max_chars"] > u["Data anal"]["char_len"]


def test_docx_edit_keeps_label_and_first_run_formatting(tmp_path):
    make_docx(tmp_path / "a.docx")
    units = docx_tailor.outline(tmp_path / "a.docx")
    skills = next(x for x in units if x["kind"] == "skills")
    bullet = next(x for x in units if x["kind"] == "bullet")
    plan = {"edits": [{"uid": skills["uid"], "new_text": "Python, SQL"}, {"uid": bullet["uid"], "new_text": "Shorter bullet."}]}
    docx_tailor.apply(tmp_path / "a.docx", plan, tmp_path / "b.docx")
    ps = docx.Document(str(tmp_path / "b.docx")).paragraphs
    assert ps[skills["uid"]].text == "Languages: Python, SQL" and ps[skills["uid"]].runs[0].bold  # label kept bold
    assert ps[bullet["uid"]].text == "Shorter bullet." and len(ps[bullet["uid"]].runs) == 1
    old = docx.Document(str(tmp_path / "a.docx")).paragraphs
    touched = {skills["uid"], bullet["uid"]}
    assert [p.text for i, p in enumerate(ps) if i not in touched] == [p.text for i, p in enumerate(old) if i not in touched]


def test_zero_edit_docx_is_text_identical(tmp_path):
    make_docx(tmp_path / "a.docx")
    docx_tailor.apply(tmp_path / "a.docx", {}, tmp_path / "b.docx")
    a, b = (docx.Document(str(tmp_path / n)) for n in ("a.docx", "b.docx"))
    assert [p.text for p in a.paragraphs] == [p.text for p in b.paragraphs]


def test_overlong_and_invalid_edits_are_rejected(tmp_path):
    make_docx(tmp_path / "a.docx")
    units = docx_tailor.outline(tmp_path / "a.docx")
    b = next(x for x in units if x["kind"] == "bullet")
    h = next(x for x in units if x["kind"] == "heading")
    for plan, code in [
        ({"edits": [{"uid": b["uid"], "new_text": "x" * (b["max_chars"] + 1)}]}, "too_long"),
        ({"edits": [{"uid": h["uid"], "new_text": "NEW"}]}, "not_editable"),
        ({"edits": [{"uid": 999, "new_text": "x"}]}, "bad_uid"),
        ({"edits": [{"uid": b["uid"], "new_text": "a"}] * 2}, "bad_uid"),
        ({"edits": [{"uid": x["uid"], "new_text": "a"} for x in units if x["kind"] == "bullet"]}, "too_many_edits"),  # 6 bullets, light limit is 5
        ({"reorder": [{"section": "x", "uids": [b["uid"], h["uid"]]}]}, "bad_reorder"),
    ]:
        with pytest.raises(DocError) as e:
            docx_tailor.apply(tmp_path / "a.docx", plan, tmp_path / "o.docx")
        assert e.value.code == code
    assert not (tmp_path / "o.docx").exists()


def test_reorder_swaps_paragraphs_in_place(tmp_path):
    make_docx(tmp_path / "a.docx")
    sk = [x for x in docx_tailor.outline(tmp_path / "a.docx") if x["kind"] == "skills"]
    docx_tailor.apply(tmp_path / "a.docx", {"reorder": [{"section": "SKILLS", "uids": [sk[1]["uid"], sk[0]["uid"]]}]}, tmp_path / "b.docx")
    ps = docx.Document(str(tmp_path / "b.docx")).paragraphs
    assert ps[sk[0]["uid"]].text.startswith("Tools") and ps[sk[1]["uid"]].text.startswith("Languages")


@pytest.mark.parametrize("serif", [False, True])
def test_pdf_zero_edit_and_five_edits_pass_verify(tmp_path, serif):
    from jobagent.docs.verify import verify

    make_pdf(tmp_path / "a.pdf", serif)
    units = pdf_tailor.outline(tmp_path / "a.pdf")
    assert [u["kind"] for u in units].count("bullet") == 6
    assert next(u for u in units if u["text"].startswith("Data"))["kind"] == "summary"
    r = pdf_tailor.apply(tmp_path / "a.pdf", {}, tmp_path / "z.pdf")
    assert verify(tmp_path / "a.pdf", tmp_path / "z.pdf", [], r["overflow"])["ok"]
    plan = {"edits": [{"uid": u["uid"], "new_text": u["text"].replace("Built", "Created")[: u["max_chars"]]} for u in units if u["kind"] == "bullet"][:5]}
    r = pdf_tailor.apply(tmp_path / "a.pdf", plan, tmp_path / "e.pdf")
    by = {u["uid"]: u for u in units}
    ed = [{"old": by[e["uid"]]["text"], "new": e["new_text"], **x} for e, x in zip(plan["edits"], r["edited"])]
    v = verify(tmp_path / "a.pdf", tmp_path / "e.pdf", ed, r["overflow"])
    assert v["ok"], v
    assert "Created dashboards" in pdf_text(tmp_path / "e.pdf")


def test_pdf_overflow_and_missing_text_are_caught(tmp_path, monkeypatch):
    from jobagent.docs.verify import verify

    make_pdf(tmp_path / "a.pdf")
    monkeypatch.setattr(pdf_tailor, "check_plan", lambda *a: None)  # the length check would stop it first; verify is the second line of defence
    u = next(x for x in pdf_tailor.outline(tmp_path / "a.pdf", "moderate") if x["kind"] == "summary")
    r = pdf_tailor.apply(tmp_path / "a.pdf", {"edits": [{"uid": u["uid"], "new_text": "word " * (u["max_chars"] // 2)}]}, tmp_path / "o.pdf", "moderate")
    assert r["overflow"] == [u["uid"]]
    v = verify(tmp_path / "a.pdf", tmp_path / "o.pdf", [{"old": u["text"], "new": "never written", **r["edited"][0]}], r["overflow"])
    assert not v["ok"] and {c["name"] for c in v["checks"] if not c["ok"]} >= {"no overflow", "edits present"}


def test_cli_outline_reports_json(tmp_path, capsys):
    make_docx(tmp_path / "base_resume.docx")
    assert cli.main(["--data-dir", str(tmp_path), "resume", "outline"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["format"] == "docx" and "bbox" not in json.dumps(out) and out["units"][0]["uid"] == 0
    assert cli.main(["--data-dir", str(tmp_path / "none"), "tailor", "j-1"]) == 1  # no resume: clean JSON error
    assert json.loads(capsys.readouterr().out)["code"] == "no_resume"


def test_job_id_is_validated(tmp_path):
    make_docx(tmp_path / "base_resume.docx")
    with pytest.raises(DocError) as e:
        tailor.tailor(tmp_path, "../evil")
    assert e.value.code == "bad_job_id"


# ---- end to end with a real converter -----------------------------------------------------

@needs_converter
def test_docx_end_to_end_zero_edit_five_edits_and_overlong(tmp_path):
    make_docx(tmp_path / "base_resume.docx")
    chk = tailor.resume_check(tmp_path)
    assert chk["ok"], chk
    units = docx_tailor.outline(tmp_path / "base_resume.docx")
    j = tmp_path / "jobs" / "j-1"
    j.mkdir(parents=True)
    (j / "tailor_plan.json").write_text(json.dumps(five_edits(units)))
    r = tailor.tailor(tmp_path, "j-1")
    assert r["ok"], r
    assert (j / "resume.pdf").exists() and (j / "resume.docx").exists() and json.loads((j / "diff.json").read_text())["edits"]
    bad = next(u for u in units if u["kind"] == "bullet")
    (j / "tailor_plan.json").write_text(json.dumps({"edits": [{"uid": bad["uid"], "new_text": "x" * 500}]}))
    with pytest.raises(DocError) as e:
        tailor.tailor(tmp_path, "j-1")
    assert e.value.code == "too_long"
    assert tailor.tailor(tmp_path, "j-1", fallback=True)["fallback"]


@needs_converter
def test_cover_letter_word_limit_and_files(tmp_path):
    make_docx(tmp_path / "base_resume.docx")
    (tmp_path / "profile.md").write_text("# Profile\n## Contact\n- full_name: Jane Doe\n- email: jane@example.com\n- phone: 555\n- location: Springfield\n")
    j = tmp_path / "jobs" / "j-1"
    j.mkdir(parents=True)
    (j / "cover_letter.md").write_text("word " * 251)
    with pytest.raises(DocError):
        tailor.cover_letter(tmp_path, "j-1")
    (j / "cover_letter.md").write_text("Para one is short.\n\nPara two too.")
    assert tailor.cover_letter(tmp_path, "j-1")["ok"] and (j / "cover_letter.pdf").exists()
    assert "Jane Doe" in pdf_text(j / "cover_letter.pdf")
