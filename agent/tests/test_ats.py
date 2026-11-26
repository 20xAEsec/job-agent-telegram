"""ATS rebuild: resume versions, the line-item bank, truth checks, rendering and the keyword score. Dummy data only."""
import json

import pymupdf
import pytest

from jobagent import cli, resume, review, tailor
from jobagent.docs import ats
from jobagent.docs.plan import DocError

MAIN = ["JANE DOE", "EXPERIENCE", "Data Analyst | Acme Corp | 2020 - 2025",
        "- Built dashboards in SQL and dbt that cut weekly reporting time by a third across four teams.",
        "- Automated data quality checks for 40 pipelines using Python, saving about six hours every week.",
        "EDUCATION", "B.S. Statistics, State University, 2019", "SKILLS", "Python, SQL, dbt, Tableau"]
V2 = ["JANE DOE", "Data Analyst, Acme Corp",
      "- Cut cloud costs 25% by moving batch jobs to AWS Lambda.", "Skills: AWS, Snowflake"]
BANK = {
    "roles": [{"id": "r1", "title": "Data Analyst", "org": "Acme Corp", "dates": "2020 - 2025", "bullets": [
        {"id": "b1", "text": MAIN[3][2:]}, {"id": "b2", "text": MAIN[4][2:]}, {"id": "b3", "text": V2[2][2:]}]}],
    "skills": ["Python", "SQL", "dbt", "Tableau", "AWS", "Snowflake"],
    "education": [{"id": "e1", "text": "B.S. Statistics, State University, 2019"}],
}
ANALYSIS = {"ats_keywords": [
    {"term": "Data Analyst", "kind": "title", "required": True}, {"term": "SQL", "required": True},
    {"term": "Snowflake", "required": True}, {"term": "Amazon Web Services", "aliases": ["AWS"], "kind": "hard"},
    {"term": "Kubernetes", "kind": "hard", "required": True}, {"term": "Communication", "kind": "soft"}]}
PROFILE = ("# Profile\n## Contact\n- full_name: Jane Doe\n- email: jane@example.com\n- location: Springfield\n"
           "## Confirmed skills\n- confirmed: Looker\n## Achievements\n- a1: Reduced churn 12% with a retention model\n"
           "## Saved answers\n### k8s\n- question: Do you know Kubernetes?\n- answer: No\n")
PLAN = {
    "headline": "Data Analyst",
    "summary": "Data Analyst with 6 years of SQL, Snowflake and Python work.",
    "skills": [{"label": "Data", "items": ["SQL", "Snowflake", "Python", "dbt", "Looker"]}, {"label": "Cloud", "items": ["Amazon Web Services (AWS)"]}],
    "roles": [{"id": "r1", "bullets": [
        {"src": "b3", "text": "Cut cloud costs 25% by moving batch jobs to Amazon Web Services (AWS) Lambda.", "reason": "their AWS wording"},
        {"src": "b1", "text": "Built SQL and dbt dashboards that cut weekly reporting time by a third across four teams."},
        {"src": "a1", "text": "Reduced churn 12% with a retention model built in Python."}]}],
}


def make_pdf(path, lines):
    doc = pymupdf.open()
    page, y = doc.new_page(), 50
    for ln in lines:
        page.insert_textbox(pymupdf.Rect(50, y, 560, y + 30), ln, fontname="helv", fontsize=10)
        y += 32
    doc.save(path)
    return path


def setup(tmp_path, bank=BANK, plan=PLAN):
    resume.import_resume(tmp_path, make_pdf(tmp_path / "main.pdf", MAIN))
    resume.import_resume(tmp_path, make_pdf(tmp_path / "1712345678-Jane V2.pdf", V2), version=True)
    (tmp_path / "profile.md").write_text(PROFILE, encoding="utf-8")
    (tmp_path / "settings.json").write_text(json.dumps({"apply": {"tailoring": "ats"}, "filters": {"years_experience": 6}}))
    if bank is not None:
        (tmp_path / "resume_bank.json").write_text(json.dumps(bank))
    j = tmp_path / "jobs" / "j-1"
    j.mkdir(parents=True)
    (j / "analysis.json").write_text(json.dumps(ANALYSIS))
    (j / "tailor_plan.json").write_text(json.dumps(plan))
    return j


def text_of(p):
    with pymupdf.open(p) as d:
        return "\n".join(x.get_text() for x in d)


def test_versions_are_named_listed_removed_and_drop_the_bank(tmp_path):
    setup(tmp_path)
    assert resume.versions(tmp_path) == ["jane-v2"]  # the inbox timestamp is dropped
    assert resume.import_resume(tmp_path, tmp_path / "1712345678-Jane V2.pdf", version=True)["version"] == "jane-v2-2"
    assert not (tmp_path / "resume_bank.json").exists()  # a new version means the bank must be rebuilt
    assert [s["name"] for s in resume.sources(tmp_path)] == ["main", "jane-v2", "jane-v2-2"]
    assert (tmp_path / "base_resume.pdf").exists() and resume.remove_version(tmp_path, "jane-v2-2")["versions"] == ["jane-v2"]
    with pytest.raises(resume.ResumeError):
        resume.remove_version(tmp_path, "../base_resume")


def test_bank_status_and_invented_lines_are_rejected(tmp_path, capsys):
    setup(tmp_path, bank=None)
    assert tailor.bank_status(tmp_path)["status"] == "missing"
    (tmp_path / "resume_bank.json").write_text(json.dumps(BANK))
    st = tailor.bank_status(tmp_path)
    assert (st["status"], st["versions"], st["bullets"], st["skills"]) == ("ready", 2, 3, 6)
    bad = json.loads(json.dumps(BANK))
    bad["roles"][0]["bullets"].append({"id": "b9", "text": "Led a team of 40 engineers at Google."})
    bad["skills"].append("Kubernetes")
    (tmp_path / "resume_bank.json").write_text(json.dumps(bad))
    assert cli.main(["--data-dir", str(tmp_path), "resume", "bank"]) == 1
    out = json.loads(capsys.readouterr().out)
    assert out["code"] == "bad_bank" and "b9" in out["error"] and "Kubernetes" in out["error"]


def test_ats_rebuild_end_to_end(tmp_path):
    j = setup(tmp_path)
    r = tailor.tailor(tmp_path, "j-1")
    assert r["ok"], r
    assert r["pages"] == 1 and r["versions_used"] == ["jane-v2", "main"] and r["reworded"] == 3
    k = r["keywords"]
    assert k["after"] > k["before"] and "Kubernetes" in k["missing_not_on_your_resumes"] and not k["missing_you_have"]
    t = text_of(j / "resume.pdf")
    for s in ("Jane Doe", "Springfield | jane@example.com", "Experience", "Education", "B.S. Statistics", "Amazon Web Services (AWS)", "Looker", "Snowflake"):
        assert s in t, s  # raw text, ligatures kept: "Snowflake" must not come out with an "fl" ligature glyph
    assert "b2" not in t and MAIN[4][2:30] not in t  # an unpicked bullet stays out
    d = json.loads((j / "diff.json").read_text())
    assert d["mode"] == "ats" and d["verify"]["ok"] and d["edits"][0]["old"] == V2[2][2:]
    cov = review.coverage(tmp_path, "j-1", ["resume.pdf"])
    assert cov["after"] == k["after"] and cov["missing"][0] == "Kubernetes"


@pytest.mark.parametrize("change, why", [
    (lambda p: p["skills"][0]["items"].append("Kubernetes"), "'Kubernetes' is not on any"),  # a saved "No" answer backs nothing
    (lambda p: p["roles"][0]["bullets"][0].update(text="Cut cloud costs 40% with AWS Lambda."), "number(s) 40"),
    (lambda p: p["roles"][0]["bullets"][1].update(text="Built SQL dashboards on Kubernetes for four teams."), "'Kubernetes' is not on any"),
    (lambda p: p["roles"][0]["bullets"][1].update(src="b7"), "bullet source 'b7'"),
    (lambda p: p["roles"][0]["bullets"][1].update(src="b3"), "used twice"),
    (lambda p: p.update(summary="Data Analyst with 10 years of SQL."), "number(s) 10"),
    (lambda p: p.update(education=["e9"]), "education"),
    (lambda p: p.update(roles=[{"id": "r2", "bullets": []}]), "unknown or repeated role"),
])
def test_truth_checks_reject_unbacked_plans(tmp_path, change, why):
    plan = json.loads(json.dumps(PLAN))
    change(plan)
    setup(tmp_path, plan=plan)
    with pytest.raises(DocError) as e:
        tailor.tailor(tmp_path, "j-1")
    assert e.value.code == "bad_plan" and why in str(e.value), str(e.value)


def test_too_long_shrinks_then_refuses(tmp_path):
    bank = {"roles": [{"id": "r1", "title": "Analyst", "bullets": [{"id": f"b{i}", "text": f"Bullet {i} " + "word " * 40} for i in range(60)]}],
            "certifications": [{"id": "c1", "text": "Certified Snowflake Professional, office workflow"}]}  # left out of the plan: kept
    plan = {"roles": [{"id": "r1", "bullets": [{"src": b["id"], "text": b["text"]} for b in bank["roles"][0]["bullets"]]}]}
    with pytest.raises(DocError) as e:
        ats.compose(plan, bank, {"full_name": "A"}, {}, tmp_path / "r.pdf", pymupdf.paper_rect("letter"))
    assert e.value.code == "too_long" and not (tmp_path / "r.pdf").exists()
    plan["roles"][0]["bullets"] = plan["roles"][0]["bullets"][:14]
    r = ats.compose(plan, bank, {"full_name": "A"}, {}, tmp_path / "r.pdf", pymupdf.paper_rect("letter"))
    assert r["pages"] == 1 and r["verify"]["ok"], r["verify"]  # includes the no-ligature check
    assert "Certifications" in r["text"] and "office workflow" in r["text"]


def test_score_weights_aliases_and_whole_words():
    kws = ats.keywords({"ats_keywords": [{"term": "C++", "required": True}, {"term": "Amazon Web Services", "aliases": ["AWS"]},
                                         {"term": "Teamwork", "kind": "soft"}, {"term": ""}, "junk"]})
    assert [k["term"] for k in kws] == ["C++", "Amazon Web Services", "Teamwork"]
    assert ats.score("C++ and AWS", kws) == {"score": round(100 * 5 / 6), "missing": ["Teamwork"]}
    assert ats.score("Cassandra, LAWS", kws)["score"] == 0  # no partial-word hits


def test_resume_check_still_works_in_ats_mode(tmp_path):
    setup(tmp_path)
    assert tailor.resume_check(tmp_path)["ok"]
