import json

from jobagent import cli


def _run(tmp_path, capsys, argv):
    rc = cli.main(["--data-dir", str(tmp_path), *argv])
    return rc, json.loads(capsys.readouterr().out)


def test_unexpected_crash_is_logged_with_frames_but_without_its_message(tmp_path, capsys, monkeypatch):
    def boom(a):
        raise KeyError("my-secret-answer")

    monkeypatch.setattr(cli, "_dispatch", boom)
    rc, res = _run(tmp_path, capsys, ["setup-check"])
    assert rc == 1 and res["code"] == "internal"
    text = (tmp_path / "logs" / "agent.log").read_text(encoding="utf-8")
    assert "setup-check -> internal (KeyError)" in text and "boom" in text
    assert "my-secret-answer" not in text


def test_known_failures_log_their_code(tmp_path, capsys):
    rc, res = _run(tmp_path, capsys, ["job", "get", "no-such-job"])
    assert rc == 1
    assert f"job -> {res['code']}" in (tmp_path / "logs" / "agent.log").read_text(encoding="utf-8")


def test_success_writes_nothing(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(cli, "_dispatch", lambda a: {"ok": True})
    _run(tmp_path, capsys, ["setup-check"])
    assert not (tmp_path / "logs").exists()
