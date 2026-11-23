import hashlib
import json
import time

from jobagent import check, cli, pair


def test_new_code_stores_only_a_hash(tmp_path):
    r = pair.new_code(tmp_path)
    stored = json.loads((tmp_path / "pair.json").read_text())
    assert len(r["pairing_code"]) == 10 and all(c in pair.ALPHABET for c in r["pairing_code"])
    assert stored["code_hash"] == hashlib.sha256(r["pairing_code"].encode()).hexdigest()
    assert r["pairing_code"] not in json.dumps(stored)
    assert 14 * 60 < stored["expires_at"] - time.time() <= 15 * 60
    assert stored["attempts"] == 0
    assert not list(tmp_path.glob("*.tmp"))


def test_refuses_when_already_paired_then_reset_allows(tmp_path):
    (tmp_path / "settings.json").write_text(json.dumps({"paired_user_id": 42, "dry_run": True}))
    assert pair.new_code(tmp_path)["code"] == "already_paired"
    pair.reset(tmp_path)
    s = json.loads((tmp_path / "settings.json").read_text())
    assert s == {"paired_user_id": None, "dry_run": True}  # other settings kept
    assert pair.new_code(tmp_path)["ok"]


def test_cli_prints_single_json_object(tmp_path, capsys):
    rc = cli.main(["--data-dir", str(tmp_path), "pair", "--new"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0 and out["ok"]


def test_setup_check_flags_missing_token(tmp_path):
    r = check.run(tmp_path)
    token = next(c for c in r["checks"] if c["name"] == "telegram token")
    assert not token["ok"] and not r["ok"]
    (tmp_path / ".env").write_text("TELEGRAM_BOT_TOKEN=123:abc\n")
    assert next(c for c in check.run(tmp_path)["checks"] if c["name"] == "telegram token")["ok"]


def test_link_and_qr_for_the_bot(tmp_path):
    r = pair.new_code(tmp_path, "@my_job_bot")
    assert r["link"] == f"https://t.me/my_job_bot?start={r['pairing_code']}"
    assert len(r["qr"].splitlines()) > 10  # a drawn QR code, not the bare link
