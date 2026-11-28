import json
import shutil
from pathlib import Path

import pytest

from jobagent import bench, llm
from jobagent.discover import boards, eligibility as e

US = {"United States"}
BENCH = Path(__file__).parent / "fixtures" / "bench"


@pytest.mark.parametrize("loc", ["Brazil (Remote)", "Remote - India", "Remote, Canada", "Lisbon, Portugal (Remote)", "London, UK (Remote)",
                                 "Remote (EMEA)", "LATAM"])
def test_where_dropped_for_us_user(loc):
    v, why = e.where(loc, "", US)
    assert v == "no" and why and "_" not in why


@pytest.mark.parametrize("loc", ["Remote - US", "Remote", "Anywhere", "North America", "San Diego, CA", "Toronto, ON or Remote US",
                                 "Atlanta, Georgia", "Albuquerque, New Mexico"])
def test_where_kept_for_us_user(loc):
    assert e.where(loc, "", US)[0] in ("ok", "unknown")


def test_where_reads_the_posting():
    assert e.where("Remote", "About us.\nYou must be based in Brazil to apply.", US) == ("no", "Only for people based in Brazil")
    assert e.where("Remote", "We have offices in London and Berlin.", US)[0] == "unknown"  # offices are not a limit
    assert e.where("Remote", "Candidates must be located in the United States or Canada.", US)[0] == "ok"
    assert e.where("Brazil (Remote)", "", set())[0] == "unknown"  # no country set: never drops
    assert e.where("Remote, Canada", "", {"Canada"})[0] == "ok"
    assert e.user_countries({"country": "", "locations": ["San Diego, CA", "Remote"]}) == US


@pytest.mark.parametrize("text,cur,top", [
    ("Pay range: $180,000 - $240,000 USD", "USD", 240_000),
    ("$150k – $210k plus equity", "USD", 210_000),
    ("raised $50M, founded 2015, 10-20 people", "USD", None),
    ("$1,000 signing bonus", "USD", None),
    ("60.000 €", "EUR", 60_000),
    ("EUR 60,000–70,000", "EUR", 70_000),
    ("CA$175k", "CAD", 175_000),
    ("₹6–7.5M", "INR", 7_500_000),
    ("R$ 15.000 por mês", "BRL", 180_000),
    ("$25 - $40 an hour", "USD", 83_200),
    ("$8,000/month", "USD", 96_000),
    ("$95-120k", "USD", 120_000),
    ("Salary £55,000 - £70,000 per year", "GBP", 70_000),
])
def test_pay_formats(text, cur, top):
    assert e.pay(text, None, cur) == top


def test_pay_converts_and_prefers_structured():
    assert 85_000 <= e.pay("Salary £55,000 - £70,000 per year", None, "USD") <= 92_000  # fixed-rate table
    assert e.pay("$1 - $2", 150_000, "USD") == 150_000
    assert e.pay_check(80_000, {"min_salary": 95_000, "currency": "USD"}) == ("no", "Pay tops out at $80k, below your $95k minimum")
    assert e.pay_check(86_000, {"min_salary": 95_000})[0] == "ok"  # within 10%
    assert e.pay_check(None, {"min_salary": 95_000})[0] == "unknown"


def test_level_and_kind():
    sen = {"experience_level": "senior", "years_experience": 9}
    assert e.level("Junior Data Analyst", "", sen)[0] == "no"
    assert e.level("Data Analyst", "Requires 1-3 years of experience", sen)[0] == "no"
    assert e.level("Data Analyst", "1-3 years with SQL; 8+ years overall", sen)[0] == "ok"
    assert e.level("Junior Data Analyst", "", {"experience_level": "mid"})[0] == "ok"
    assert e.level("Junior Data Analyst", "", {"experience_level": ["senior", "manager"]})[0] == "no"
    assert e.level("Junior Data Analyst", "", {"experience_level": ["mid", "senior"]})[0] == "ok"
    assert e.kind("FullTime", "Contract Manager", ["full_time"])[0] == "ok"
    assert e.kind(None, "Data Analyst (Contract)", ["full_time"]) == ("no", "A contract role; you asked for full time")
    assert e.kind("Part-time", "Analyst", ["full_time", "contract"])[0] == "no"
    assert e.kind(None, "Data Analyst - Freelance", ["contract"])[0] == "ok"
    assert e.kind(None, "Data Analyst", ["full_time"])[0] == "unknown"


def test_rules_drop_aggregator_without_place():
    f = {"country": "United States"}
    assert e.rules({"location": "", "board": "jobgether"}, "A role for a partner company.", f, US)[0] == "aggregator"
    assert e.rules({"location": "Remote - US", "board": "jobgether"}, "", f, US) is None
    assert e.rules({"location": "", "board": "acme"}, "", f, US) is None


def test_learn_refuses_aggregators(tmp_path):
    assert boards.learn(tmp_path, [("greenhouse", "jobgether"), ("lever", "acme")]) == ["acme"]


def _snapshot(p: Path) -> dict:
    return {str(x.relative_to(p)): (x.stat().st_size, x.stat().st_mtime_ns) for x in p.rglob("*")}


def test_bench_counts_without_writing_or_printing_postings(tmp_path, monkeypatch):
    src = tmp_path / "data"
    shutil.copytree(BENCH, src)
    before = _snapshot(src)
    r = bench.screen(src)
    assert r["jobs"] == 5 and r["dropped_early"] == 3 and r["rules"] == {"where": 1, "pay": 1, "level": 1}
    assert r["by_status"]["AWAITING_APPROVAL"] == {"jobs": 1, "rules": 0, "triage": 0, "kept": 1}
    seen = []
    monkeypatch.setattr(bench, "_claude", lambda name, stdin, model: seen.append((name, model)) or {"jobs": [
        {"id": "a2", "score": 85, "reason": "Same work"}, {"id": "a5", "score": 20, "reason": "Sales role, not security"}]})
    r = bench.screen(src, use_llm=True)
    assert seen == [("screen", "haiku")] and r["llm"] == {"ran": True, "calls": 1, "failed": 0}
    assert r["dropped_early"] == 4 and r["by_status"]["SKIPPED"]["triage"] == 1 and r["by_status"]["AWAITING_APPROVAL"]["kept"] == 1
    assert "ZEBRA" not in json.dumps(r)  # posting text never printed
    assert _snapshot(src) == before


def test_screen_accept(tmp_path):
    d = tmp_path
    (d / "settings.json").write_text(json.dumps({"apply": {"min_match_score": 60}}))
    cands = [{"job_id": i, "title": t, "company": "Co", "url": f"https://x/{i}", "excerpt": "Must know SQL."} for i, t in (("j1", "Analyst"), ("j2", "Sales"), ("j3", "Data"))]
    (d / "run").mkdir()
    (d / "run" / "poll.json").write_text(json.dumps({"candidates": cands}))
    ids = {"ids": ["j1", "j2", "j3"]}
    (d / "feedback.jsonl").write_text(json.dumps({"job_id": "x", "decision": "skip_reason", "reason": "kind of work"}) + "\n")
    inp = json.loads(Path(llm.build_input(d, "screen", None, ids)["file"]).read_text("utf-8"))
    assert "<untrusted_content" in inp["jobs"] and "Must know SQL" in inp["jobs"]
    assert inp["feedback"]["skip_reasons"] == {"kind of work": 1}  # v3 P2
    with pytest.raises(Exception):
        llm.build_input(d, "screen", None, {"ids": ["nope"]})

    def acc(rows):
        (d / "ans.json").write_text(json.dumps({"jobs": rows}))
        return llm.accept(d, "screen", None, str(d / "ans.json"), ids)

    assert acc([{"id": "j1", "score": 90, "reason": "ok"}])["errors"] == ["j2: missing", "j3: missing"]
    assert acc([{"id": "zz", "score": 1, "reason": ""}, {"id": "j1", "score": 101, "reason": ""}])["code"] == "rejected"
    r = acc([{"id": "j1", "score": 90, "reason": "Same work"}, {"id": "j2", "score": 30, "reason": "Sales role " * 20}, {"id": "j3", "score": 55, "reason": "Close"}])
    assert r["ok"] and r["bar"] == 50 and r["filtered"] == 1
    rows = [json.loads(x) for x in (d / "screened.jsonl").read_text("utf-8").splitlines()]
    assert [(x["job_id"], x["stage"], x["score"]) for x in rows] == [("j2", "triage", 30)] and len(rows[0]["reason"]) <= 90
    assert "j2" in json.loads((d / "seen.json").read_text()) and set(json.loads((d / "screen_scores.json").read_text())) == {"j1", "j3"}
