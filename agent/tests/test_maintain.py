"""v4 AP6: jobagent maintain prunes only rebuildable files of old finished jobs, expires unanswered auto-search jobs, trims screened.jsonl."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jobagent import cli, maintain, store

NOW = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)
FILES = ["posting.md", "resume.pdf", "resume.docx", "page.png", "analysis.json", "review.json", "approval.json", "result.json"]


def job(d: Path, name: str, statuses: list[str], days: int, source: str = "manual") -> Path:
    jid = store.new_job(d, f"https://example.test/jobs/{name}", source)["job_id"]
    at = (NOW - timedelta(days=days)).isoformat(timespec="seconds")
    (store.jdir(d, jid) / "status.json").write_text(json.dumps({"status": statuses[-1], "updated_at": at,
                                                               "history": [{"status": s, "at": at, "detail": ""} for s in statuses]}))
    j = store.jdir(d, jid)
    for f in FILES:
        (j / f).write_text("x")
    (j / "screenshots").mkdir()
    (j / "screenshots" / "1.png").write_text("x")
    (d / "listings").mkdir(exist_ok=True)
    (d / "listings" / f"{jid}.md").write_text("x")
    return j


def everything(j: Path, d: Path) -> set[str]:
    return {p.name for p in j.iterdir()} | ({"listing"} if (d / "listings" / f"{j.name}.md").exists() else set())


def test_maintain_on_a_fixture_folder(tmp_path, capsys):
    d = tmp_path
    (d / "profile.md").write_text("me")
    old_skip = job(d, "old-skip", ["NEW", "SKIPPED"], 40)
    old_dry = job(d, "old-dry", ["NEW", "DRY_RUN_DONE"], 31)
    keep = {
        "recent skip": job(d, "new-skip", ["NEW", "SKIPPED"], 10),
        "submitted": job(d, "sent", ["NEW", "SUBMITTED"], 90),
        "submitted then closed": job(d, "sent-closed", ["NEW", "SUBMITTED", "CLOSED"], 90),
        "applied myself": job(d, "self", ["NEW", "KIT_READY", "APPLIED_SELF"], 90),
        "user's own link": job(d, "manual-wait", ["NEW", "NEEDS_ANSWERS"], 30),
        "fresh question": job(d, "fresh-wait", ["NEW", "NEEDS_ANSWERS"], 3, "discovery"),
    }
    stale = job(d, "stale-review", ["NEW", "AWAITING_APPROVAL"], 8, "discovery")
    stale_q = job(d, "stale-question", ["NEW", "NEEDS_ANSWERS"], 8, "discovery")
    before = {k: everything(j, d) for k, j in keep.items()}
    rows = [{"at": (NOW - timedelta(days=n)).isoformat(timespec="seconds"), "job_id": f"s{n}"} for n in (45, 31, 2)]
    (d / "screened.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))

    out = maintain.run(d, NOW)

    assert out["ok"] and (out["pruned"], out["expired"], out["trimmed"]) == (2, 2, 2)
    assert sorted(out["expired_ids"]) == sorted([stale.name, stale_q.name])
    for j in (old_skip, old_dry):  # rebuildable files gone, the JSON record stays
        assert everything(j, d) == {"meta.json", "status.json", "analysis.json", "review.json", "approval.json", "result.json"}
    for k, j in keep.items():
        assert everything(j, d) == before[k], k
    for j in (stale, stale_q):  # expired: skipped with a plain reason, files kept
        st = store.status(d, j.name)
        assert st["status"] == "SKIPPED" and st["history"][-1]["detail"] == maintain.EXPIRED
        assert "posting.md" in everything(j, d)
    assert [json.loads(ln)["job_id"] for ln in (d / "screened.jsonl").read_text().splitlines()] == ["s2"]
    assert (d / "profile.md").read_text() == "me"
    assert json.loads((d / "upkeep.json").read_text()) == {"at": NOW.isoformat(timespec="seconds"), "pruned": 2, "expired": 2, "trimmed": 2}

    again = maintain.run(d, NOW)  # nothing left to do
    assert (again["pruned"], again["expired"], again["trimmed"]) == (0, 0, 0)

    assert cli.main(["--data-dir", str(d), "maintain"]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_maintain_is_denied_to_claude():
    deny = json.loads((Path(__file__).parents[2] / ".claude" / "settings.json").read_text())["permissions"]["deny"]
    assert "Bash(uv run --project agent jobagent maintain:*)" in deny
