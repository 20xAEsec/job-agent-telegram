import json

import docx
import pymupdf
import pytest

from jobagent import cli, profile, resume

SAMPLE = (
    "# Profile\n## Contact\n- full_name: Jane Doe\n- email: jane@example.com\n"
    "## Summary\nFree text\n\n## Weird Custom Section\n  keep   me \t\n- not: parsed\n"
    "## Saved answers\n<!-- note -->\n### a_key\n- question: Q?\n- answer: No\n- sensitive: true\n"
    "- scope: global\n- source_job: j-1\n- updated: 2026-11-22\n"
)


def write(d, text, crlf=False):
    (d / "profile.md").write_bytes((text.replace("\n", "\r\n") if crlf else text).encode())


def raw(d):
    return (d / "profile.md").read_bytes().decode()


@pytest.mark.parametrize("crlf", [False, True])
def test_roundtrip_untouched_sections_are_byte_identical(tmp_path, crlf):
    write(tmp_path, SAMPLE, crlf)
    before = raw(tmp_path)
    profile.answer_set(tmp_path, "new_key", "Q2?", "yes")
    profile.answer_delete(tmp_path, "new_key")
    assert raw(tmp_path) == before  # set then delete leaves the file exactly as it was
    profile.answer_set(tmp_path, "a_key", "Q?", "Yes")  # change an existing answer
    assert raw(tmp_path).split("### a_key")[0] == before.split("### a_key")[0]  # everything before is untouched


def test_parse_answer_and_unknown_section_kept(tmp_path):
    write(tmp_path, SAMPLE)
    a = profile.answer_get(tmp_path, "a_key")["answer"]
    assert (a["question"], a["answer"], a["sensitive"], a["scope"]) == ("Q?", "No", True, "global")
    assert "  keep   me \t\n- not: parsed\n" in raw(tmp_path)
    assert profile.show(tmp_path, "Contact")["fields"]["email"] == "jane@example.com"


def test_job_scope_and_listing(tmp_path):
    profile.answer_set(tmp_path, "salary", "Salary?", "100000")
    profile.answer_set(tmp_path, "why_us", "Why?", "because", scope="job", job="greenhouse-acme-1")
    profile.answer_set(tmp_path, "why_us", "Why?", "other", scope="job", job="lever-foo-2")

    def keys(**kw):
        return sorted(a["key"] for a in profile.answer_list(tmp_path, **kw)["answers"])

    assert keys() == ["salary"]
    assert keys(include_job="greenhouse-acme-1") == ["greenhouse-acme-1__why_us", "salary"]
    e = profile.answer_get(tmp_path, "greenhouse-acme-1__why_us")["answer"]
    assert e["base_key"] == "why_us" and e["job"] == "greenhouse-acme-1"


def test_multiline_and_backslash_values_roundtrip_without_breaking_structure(tmp_path):
    nasty = "line1\n## Injected\n### fake_key\nback\\slash \\n literal"
    profile.answer_set(tmp_path, "free", "Why?\nSecond line", nasty)
    assert "\n## Injected" not in raw(tmp_path)
    a = profile.answer_get(tmp_path, "free")["answer"]
    assert a["answer"] == nasty and a["question"] == "Why?\nSecond line"
    assert [x["key"] for x in profile.answer_list(tmp_path)["answers"]] == ["free"]


@pytest.mark.parametrize("key", ["Bad Key", "has-dash", "", "x" * 41, "ssn_us", "bank_account", "my_passport"])
def test_bad_or_forbidden_keys_rejected(tmp_path, key):
    with pytest.raises(profile.ProfileError):
        profile.answer_set(tmp_path, key, "Q", "v")


def test_job_scope_needs_job_and_delete_missing(tmp_path):
    with pytest.raises(profile.ProfileError):
        profile.answer_set(tmp_path, "k", "Q", "v", scope="job")
    with pytest.raises(profile.ProfileError):
        profile.answer_delete(tmp_path, "nope")


def test_write_draft_keeps_existing_saved_answers(tmp_path):
    write(tmp_path, SAMPLE)
    draft = tmp_path / "draft.md"
    draft.write_text("# Profile\n## Contact\n- full_name: New Name\n## Skills\n- languages: Python", encoding="utf-8")
    r = profile.write_draft(tmp_path, draft)
    assert "Saved answers" in r["sections"]
    assert profile.show(tmp_path, "Contact")["fields"]["full_name"] == "New Name"
    assert profile.answer_get(tmp_path, "a_key")["answer"]["answer"] == "No"
    bad = tmp_path / "bad.md"
    bad.write_text("hello", encoding="utf-8")
    with pytest.raises(profile.ProfileError):
        profile.write_draft(tmp_path, bad)


def test_new_resume_without_links_keeps_the_ones_the_user_gave(tmp_path):
    write(tmp_path, SAMPLE)
    profile.set_field(tmp_path, "Contact", "github", "https://github.com/janedoe")
    draft = tmp_path / "draft.md"
    draft.write_text("# Profile\n## Contact\n- full_name: New Name\n- github: \n## Skills\n- languages: Python", encoding="utf-8")
    profile.write_draft(tmp_path, draft)
    assert profile.show(tmp_path, "Contact")["fields"]["github"] == "https://github.com/janedoe"


def test_new_resume_keeps_fact_bank_and_confirmed_skills(tmp_path):
    write(tmp_path, SAMPLE)
    profile.set_field(tmp_path, "Confirmed skills", "confirmed", "Looker")
    profile.set_field(tmp_path, "Achievements", "a1", "At Acme I built " + "x" * 400)
    draft = tmp_path / "draft.md"
    draft.write_text("# Profile\n## Contact\n- full_name: New Name", encoding="utf-8")
    profile.write_draft(tmp_path, draft)
    assert profile.show(tmp_path, "Confirmed skills")["fields"]["confirmed"] == "Looker"
    assert len(profile.show(tmp_path, "Achievements")["fields"]["a1"]) == 416
    assert profile.answer_get(tmp_path, "a_key")["answer"]["answer"] == "No"


def test_resume_import_docx_and_pdf(tmp_path):
    d = tmp_path / "data"
    src = tmp_path / "r.docx"
    doc = docx.Document()
    doc.add_paragraph("Jane Doe, Data Analyst")
    doc.save(src)
    r = resume.import_resume(d, src)
    assert r["chars"] > 0 and (d / "base_resume.docx").exists()
    assert "Data Analyst" in (d / "resume_text.txt").read_text()
    pdf = tmp_path / "r.pdf"
    p = pymupdf.open()
    p.new_page().insert_text((72, 72), "Jane Doe SQL dbt")
    p.save(pdf)
    resume.import_resume(d, pdf)
    assert (d / "base_resume.pdf").exists() and not (d / "base_resume.docx").exists()  # one base resume at a time
    assert "SQL" in (d / "resume_text.txt").read_text()
    with pytest.raises(resume.ResumeError):
        resume.import_resume(d, tmp_path / "x.txt")


def test_cli_set_with_leading_dash_value(tmp_path, capsys):
    assert cli.main(["--data-dir", str(tmp_path), "profile", "answer", "set", "k", "--question=Q", "--value=-5"]) == 0
    cli.main(["--data-dir", str(tmp_path), "profile", "answer", "get", "k"])
    out = [json.loads(l) for l in capsys.readouterr().out.splitlines()]
    assert out[-1]["answer"]["answer"] == "-5"
    assert cli.main(["--data-dir", str(tmp_path), "profile", "answer", "delete", "zzz"]) == 1


def test_set_field_replaces_or_adds_and_keeps_the_rest(tmp_path):
    write(tmp_path, SAMPLE)
    before = raw(tmp_path)
    profile.set_field(tmp_path, "Contact", "full_name", "Jane Q. Doe")
    profile.set_field(tmp_path, "Contact", "phone", "+1  555\n0100")
    after = raw(tmp_path)
    assert "- full_name: Jane Q. Doe\n- email: jane@example.com\n- phone: +1 555 0100\n## Summary" in after
    assert after.split("## Summary")[1] == before.split("## Summary")[1]
    assert profile.show(tmp_path, "Contact")["fields"]["phone"] == "+1 555 0100"


def test_set_field_creates_a_missing_section_before_saved_answers(tmp_path):
    write(tmp_path, SAMPLE)
    profile.set_field(tmp_path, "Links", "github", "https://github.com/jane")
    assert raw(tmp_path).index("## Links") < raw(tmp_path).index("## Saved answers")
