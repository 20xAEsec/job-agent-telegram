import hashlib
import json
from pathlib import Path

from jobagent import cli


def tree_hash(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        h.update(str(p.relative_to(root)).encode())
        h.update(p.read_bytes() if p.is_file() else b"dir")
    return h.hexdigest()


def old_install(root: Path) -> Path:
    src = root / "job-agent-v2" / "data"
    files = {
        "settings.json": json.dumps({"version": 2, "paired_user_id": 7, "dry_run": True, "filters": {"country": "", "locations": ["San Diego, CA", "Remote"]}}),
        ".env": "TELEGRAM_BOT_TOKEN=123:fake\n", "profile.md": "## Contact\n", "feedback.jsonl": "{}\n", "boards.json": "{}",
        "jobs/greenhouse-acme-1/status.json": json.dumps({"status": "SKIPPED"}), "resumes/other.txt": "x", "browser/Default/Cookies": "c",
        "browser/SingletonLock": "l", "logs/app.log": "old", "run/app.lock": "1", "tmp/x.json": "{}",
    }
    for name, text in files.items():
        p = src / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return src


def migrate(d: Path, src: Path, capsys):
    rc = cli.main(["--data-dir", str(d), "migrate", "--from", str(src)])
    return rc, json.loads(capsys.readouterr().out)


def test_migrate_copies_a_2x_folder_and_never_writes_into_it(tmp_path, capsys):
    src, d = old_install(tmp_path), tmp_path / "v4" / "data"
    before = tree_hash(src)
    (d / "jobs").mkdir(parents=True)  # what setup leaves behind: an empty folder
    (d / ".env").write_text("TELEGRAM_BOT_TOKEN=999:setup\n")
    rc, res = migrate(d, src, capsys)
    assert rc == 0 and res["jobs"] == 1 and res["country"] == "United States"
    assert tree_hash(src) == before
    s = json.loads((d / "settings.json").read_text("utf-8"))
    assert s["version"] == 4 and s["filters"]["country"] == "United States" and s["paired_user_id"] == 7 and s["dry_run"] is True
    for kept in (".env", "profile.md", "feedback.jsonl", "boards.json", "jobs/greenhouse-acme-1/status.json", "resumes/other.txt", "browser/Default/Cookies"):
        assert (d / kept).read_bytes() == (src / kept).read_bytes(), kept
    for left in ("logs/app.log", "run", "tmp", "browser/SingletonLock", "jobs.migrating"):
        assert not (d / left).exists(), left
    assert migrate(d, src, capsys)[1]["code"] == "not_empty"  # a second run never overwrites jobs
    assert tree_hash(src) == before


def test_migrate_refuses_the_wrong_folder(tmp_path, capsys):
    src = old_install(tmp_path)
    assert migrate(tmp_path / "new", tmp_path, capsys)[1]["code"] == "not_data"
    assert migrate(src, src, capsys)[1]["code"] == "same_folder"
    assert migrate(src / "inner", src, capsys)[1]["code"] == "same_folder"
    assert not (src / "inner" / "settings.json").exists()


def test_migrate_is_denied_to_claude():
    deny = json.loads((Path(__file__).parents[2] / ".claude" / "settings.json").read_text())["permissions"]["deny"]
    assert "Bash(uv run --project agent jobagent migrate:*)" in deny
