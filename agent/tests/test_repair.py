"""Self-repair: a real temporary git repo stands in for upstream; gh, bun and uv are faked."""
import json
import subprocess
from types import SimpleNamespace

import pytest

from jobagent import repair

ID = "abc123"
PR_URL = "https://github.com/up/stream/pull/9"


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t.test", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def env(tmp_path, monkeypatch):
    up = tmp_path / "upstream"
    (up / "app/src").mkdir(parents=True)
    (up / "agent/jobagent").mkdir(parents=True)
    (up / "app/src/x.ts").write_text("export const x = 1\n")
    (up / "agent/jobagent/submit.py").write_text("SAFE = True\n")
    _git(up, "init", "-q", "-b", "main")
    _git(up, "add", "-A")
    _git(up, "commit", "-q", "-m", "init")
    root = tmp_path / "root"
    subprocess.run(["git", "clone", "-q", str(up), str(root)], check=True, capture_output=True)
    d = root / "data"
    (d / "logs").mkdir(parents=True)
    (d / "logs" / "app.log").write_text("task failed for jane.real@gmail.com in C:\\Users\\jane\\JobAgent\n")
    (d / "profile.md").write_text("# Profile\n## Contact\n- full_name: Jane Realname\n- email: jane.real@gmail.com\n")
    calls, state = [], {"login": "octo"}
    real = repair._run

    def fake(cmd, cwd=None, timeout=300, env=None):
        if cmd[0] == "gh":
            calls.append(cmd)
            if cmd[1] == "api":
                return (0, state["login"] + "\n") if state["login"] else (1, "not logged in")
            if cmd[1:3] == ["pr", "create"]:
                return 0, PR_URL + "\n"
            return 0, "ok"
        if cmd[0] in ("bun", "uv"):
            return 0, "ok"
        if "push" in cmd:
            calls.append(cmd)
            return 0, ""
        return real(cmd, cwd=cwd, timeout=timeout, env=env)

    monkeypatch.setattr(repair, "_run", fake)
    monkeypatch.setattr(repair, "UPSTREAM_URL", str(up))
    return SimpleNamespace(d=d, root=root, calls=calls, state=state)


def _fix(env, rel="app/src/x.ts", add="export const y = 2\n"):
    work = env.d.parent / repair.start(env.d, ID)["work"]
    with open(work / rel, "a") as f:
        f.write(add)
    report = {"title": "Fix x", "summary": "x was wrong.", "body": "## What\nx was wrong.\n"}
    (env.d / "repair" / ID / "report.json").write_text(json.dumps(report))
    return work


def _approve(env):
    prop = json.loads((env.d / "repair" / ID / "proposal.json").read_text())
    (env.d / "repair" / ID / "approved.json").write_text(json.dumps({"hash": prop["hash"]}))


def test_start_hides_private_details_from_the_logs_claude_reads(env):
    repair.start(env.d, ID)
    logs = (env.d / "repair" / ID / "logs.txt").read_text()
    assert "jane.real@gmail.com" not in logs and "Realname" not in logs and "C:\\Users\\jane" not in logs
    assert "task failed" in logs


def test_start_explains_a_zip_install_or_missing_github_login(env):
    env.state["login"] = ""
    with pytest.raises(repair.RepairError) as e:
        repair.start(env.d, ID)
    assert e.value.code == "no_login"
    (env.root / ".git").rename(env.root / "nogit")
    with pytest.raises(repair.RepairError) as e:
        repair.start(env.d, ID)
    assert e.value.code == "not_git"


def test_full_flow_opens_a_pr_only_after_approval(env):
    _fix(env)
    assert repair.test(env.d, ID)["ok"]
    p = repair.prepare(env.d, ID)
    assert p["files"] == ["app/src/x.ts"] and p["added"] == 1
    with pytest.raises(repair.RepairError) as e:
        repair.publish(env.d, ID)
    assert e.value.code == "not_approved" and not any("push" in c for c in env.calls)
    _approve(env)
    assert repair.publish(env.d, ID)["url"] == PR_URL
    pr = next(c for c in env.calls if c[1:3] == ["pr", "create"])
    assert pr[pr.index("--head") + 1] == f"octo:repair/{ID}" and pr[pr.index("--repo") + 1] == repair.UPSTREAM
    assert not (env.d / "repair" / ID).exists()


def test_editing_after_the_tests_ran_needs_a_new_test_run(env):
    work = _fix(env)
    repair.test(env.d, ID)
    (work / "app/src/x.ts").write_text("export const sneaky = 3\n")
    with pytest.raises(repair.RepairError) as e:
        repair.prepare(env.d, ID)
    assert e.value.code == "untested"


def test_failing_tests_block_the_proposal(env, monkeypatch):
    _fix(env)
    real = repair._run
    monkeypatch.setattr(repair, "_run", lambda cmd, **k: (1, "boom") if cmd[0] == "bun" else real(cmd, **k))
    assert repair.test(env.d, ID)["code"] == "tests_failed"
    with pytest.raises(repair.RepairError) as e:
        repair.prepare(env.d, ID)
    assert e.value.code == "untested"


def test_a_fix_may_not_touch_the_safety_code(env):
    _fix(env, rel="agent/jobagent/submit.py", add="SAFE = False\n")
    repair.test(env.d, ID)
    with pytest.raises(repair.RepairError) as e:
        repair.prepare(env.d, ID)
    assert e.value.code == "protected"


def test_personal_details_in_the_diff_or_notes_block_the_proposal(env):
    _fix(env, add="// contact jane.real@gmail.com\n")
    repair.test(env.d, ID)
    with pytest.raises(repair.RepairError) as e:
        repair.prepare(env.d, ID)
    assert e.value.code == "private" and "jane" not in str(e.value)


def test_a_changed_report_after_approval_is_not_published(env):
    _fix(env)
    repair.test(env.d, ID)
    repair.prepare(env.d, ID)
    _approve(env)
    (env.d / "repair" / ID / "report.json").write_text(json.dumps({"title": "Other", "summary": "s", "body": "different"}))
    with pytest.raises(repair.RepairError) as e:
        repair.publish(env.d, ID)
    assert e.value.code == "changed" and not any("push" in c for c in env.calls)
