import os
import re
import shutil
import subprocess
import sys


def _tool_version(name: str, arg: str = "--version") -> tuple[bool, str]:
    path = shutil.which(name)
    if not path:
        return False, f"{name} not found on PATH"
    try:
        out = subprocess.run([path, arg], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception as e:  # noqa: BLE001 - report, don't crash the check
        return False, f"{name} failed to run: {type(e).__name__}"
    return True, out.splitlines()[0] if out else path


def _token_ok(data_dir) -> tuple[bool, str]:
    env = data_dir / ".env"
    if os.environ.get("TELEGRAM_BOT_TOKEN"):
        return True, "from environment"
    if env.exists() and re.search(r"^TELEGRAM_BOT_TOKEN=\S+", env.read_text("utf-8"), re.M):
        return True, "data/.env"
    return False, "missing: run scripts/setup"


def _claude_login() -> tuple[bool, str]:
    import json

    path = shutil.which("claude")
    if not path:
        return False, "Claude Code is not installed"
    try:
        out = subprocess.run([path, "auth", "status"], capture_output=True, text=True, timeout=30).stdout
        info = json.loads(out)
    except Exception:  # noqa: BLE001 - older Claude Code without `auth status`: assume the user logs in when asked
        return True, "could not check (older Claude Code)"
    if not info.get("loggedIn"):
        return False, "not logged in: run  claude  in a terminal and log in"
    return True, str(info.get("authMethod") or "logged in")


def _writable(data_dir) -> tuple[bool, str]:
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        probe = data_dir / ".write-test"
        probe.write_text("x")
        probe.unlink()
        return True, str(data_dir)
    except OSError as e:
        return False, f"cannot write to {data_dir}: {e.strerror}"


def _chromium() -> tuple[bool, str]:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            ok = os.path.exists(p.chromium.executable_path)
        return ok, "installed" if ok else "run: uv run --project agent playwright install chromium"
    except Exception as e:  # noqa: BLE001 - report, don't crash the check
        return False, f"playwright failed to start: {type(e).__name__}"


def run(data_dir) -> dict:
    from .docs.render import has_converter

    py_ok = sys.version_info >= (3, 12)
    has_conv = has_converter()
    checks = [
        ("python>=3.12", py_ok, sys.version.split()[0]),
        ("bun", *_tool_version("bun")),
        ("claude", *_tool_version("claude")),
        ("claude login", *_claude_login()),
        ("playwright chromium", *_chromium()),
        ("docx->pdf converter", has_conv, "Word or LibreOffice" if has_conv else "install Microsoft Word or LibreOffice (or use a PDF resume)"),
        ("data dir writable", *_writable(data_dir)),
        ("telegram token", *_token_ok(data_dir)),
    ]
    optional = {"docx->pdf converter"}  # only needed for .docx resumes: a warning, not a blocker
    items = [{"name": n, "ok": ok, "detail": d, "required": n not in optional} for n, ok, d in checks]
    return {"ok": all(i["ok"] for i in items if i["required"]), "checks": items}
