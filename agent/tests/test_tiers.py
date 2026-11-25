"""Title tiers without Claude: exact / related titles, the "maybe" tier (same field, same kind of role, several of your skills),
and the precision rule that keeps sales and manager titles out unless you ask for them. Several professions, not only security."""
from datetime import datetime, timedelta, timezone

import pytest

from jobagent.discover import prefilter, tiers

SEC = ["Cyber Security Engineer", "Detection Engineer", "Security Operations Engineer", "Application Security Engineer", "AI Security Engineer",
       "Security Automation Engineer"]
DATA = ["Data Analyst", "BI Analyst"]
MKT = ["Marketing Manager", "Content Marketing Manager"]
UX = ["Product Designer", "UX Designer"]
RN = ["Registered Nurse"]

# (wanted titles, level, candidate title, tier): None = dropped for its title.
TABLE = [
    (SEC, "mid", "Security Engineer", "exact"),
    (SEC, "mid", "Senior Security Engineer", "exact"),
    (SEC, "mid", "Threat Detection Engineer", "exact"),
    (SEC, "mid", "Product Security Engineer", "exact"),
    (SEC, "mid", "Staff AI Security Researcher", "exact"),
    (SEC, "mid", "SOC Analyst", "maybe"),
    (SEC, "mid", "Security Analyst", "maybe"),
    (SEC, "mid", "Information Security Analyst", "maybe"),
    (SEC, "mid", "SecOps Engineer", "maybe"),
    (SEC, "mid", "AppSec Engineer", "maybe"),
    (SEC, "mid", "DevSecOps Engineer", "maybe"),
    (SEC, "mid", "Security Software Engineer", "maybe"),
    (SEC, "mid", "Software Engineer, Security", "maybe"),
    (SEC, "mid", "Security Architect", "maybe"),
    (SEC, "mid", "Detection and Response Analyst", "maybe"),
    (SEC, "mid", "Security Sales Engineer", None),  # passed "close" before: another line of work
    (SEC, "mid", "Security Operations Manager", None),  # passed "close" before: a manager role
    (SEC, "mid", "Senior Manager, Security Operations", None),
    (SEC, "manager", "Security Operations Manager", "exact"),  # aiming for manager: allowed
    (SEC, "mid", "Security Recruiter", None),
    (SEC, "mid", "Sales Engineer", None),
    (SEC, "mid", "Marketing Manager", None),
    (SEC, "mid", "Machine Learning Engineer", None),
    (SEC, "mid", "Software Engineer", None),
    (SEC, "mid", "Platform Engineer", None),
    (SEC, "mid", "Data Analyst", None),
    (SEC, "mid", "Trust & Safety Analyst", None),
    (SEC, "mid", "SIEM Engineer", None),  # no shared field word: needs a related title (or the board's department)
    (DATA, "mid", "Senior Data Analyst", "exact"),
    (DATA, "mid", "Business Intelligence Analyst", "exact"),
    (DATA, "mid", "Marketing Analyst", "exact"),  # still an analyst job
    (DATA, "mid", "Data Scientist", "maybe"),
    (DATA, "mid", "Data Engineer", "maybe"),
    (DATA, "mid", "Sales Analyst", None),
    (DATA, "mid", "Analytics Manager", None),
    (DATA, "mid", "Data Entry Clerk", None),  # a different kind of role
    (MKT, "manager", "Product Marketing Manager", "exact"),
    (MKT, "manager", "Marketing Director", "maybe"),
    (MKT, "manager", "Marketing Coordinator", None),
    (MKT, "manager", "Sales Manager", None),
    (MKT, "manager", "Brand Manager", None),
    (UX, "mid", "Senior Product Designer", "exact"),
    (UX, "mid", "UX Researcher", "maybe"),
    (UX, "mid", "Design Manager", None),
    (RN, "mid", "ICU Nurse", "maybe"),  # "nurse" marks another line of work only for people who are not nurses
    (RN, "mid", "Nurse Manager", None),
    (RN, "mid", "Truck Driver", None),
]


def tier(wanted, level, title, related=()):
    f = {"titles": wanted, "related_titles": list(related), "title_match": "close", "experience_level": level}
    ctx = tiers.context(None, {"filters": f})
    return prefilter.title_tier(title, f) or ("maybe" if tiers.plausible({"title": title}, ctx) else None)


@pytest.fixture(autouse=True)
def no_profile(monkeypatch):
    monkeypatch.setattr(tiers, "skills", lambda d: [])


@pytest.mark.parametrize("wanted,level,title,want", TABLE)
def test_title_tiers(wanted, level, title, want):
    assert tier(wanted, level, title) == want


def test_related_title_tier():
    assert tier(["Detection Engineer"], "mid", "Senior Threat Hunter", ["Threat Hunter"]) == "related"
    assert tier(["Detection Engineer"], "mid", "Threat Hunter") is None
    assert tier(["Detection Engineer"], "mid", "Threat Hunting Manager", ["Threat Hunter"]) is None  # same precision rule


def test_department_counts_as_the_field():
    ctx = tiers.context(None, {"filters": {"titles": SEC}})
    assert not tiers.plausible({"title": "SIEM Engineer"}, ctx)
    assert tiers.plausible({"title": "SIEM Engineer", "dept": "Security"}, ctx)
    assert not tiers.plausible({"title": "IT Engineer", "dept": "Operations"}, ctx)  # too general on its own


def test_skill_hits_whole_words():
    text = "You know C++, CI/CD and JavaScript. Kubernetes a plus."
    assert tiers.skill_hits(text, ["c++", "ci/cd", "java", "kubernetes", "python"]) == 3  # "java" is not "JavaScript"
    assert tiers.skill_hits("C#, .NET", ["c#", "c"]) == 1


def test_profile_skills(tmp_path, monkeypatch):
    monkeypatch.undo()
    (tmp_path / "profile.md").write_text("# Profile\n## Contact\n- full_name: A\n## Skills\n- languages: Python, C++, Go\n"
                                         "- tools: CI/CD, Splunk (SIEM); Terraform / AWS, python\n", "utf-8")
    assert tiers.skills(tmp_path) == ["python", "c++", "go", "ci/cd", "splunk", "siem", "terraform", "aws"]
    assert tiers.skills(tmp_path / "none") == []
    ctx = tiers.context(tmp_path, {"filters": {"titles": ["X"]}, "discovery": {"related_jobs": "more"}})
    assert (ctx.need, ctx.cap) == (3, 12)  # 8 skills: 3 must match
    assert tiers.Ctx([], "mid", set(), set(), ["python", "sql"], 4).need == 2  # fewer than 8: 2


def test_seen_titles_are_counted_once_per_title(tmp_path):
    now = datetime(2026, 11, 22, tzinfo=timezone.utc)
    tiers.note(tmp_path, ["Sr. SOC Analyst (Remote)", "SOC Analyst"], now)
    tiers.note(tmp_path, ["Security Architect"], now + timedelta(days=1))
    st = tiers.store._load(tmp_path / tiers.SEEN_TITLES)
    assert st["soc analyst"] == {"t": "SOC Analyst", "n": 2, "last": now.isoformat()} and st["security architect"]["n"] == 1
