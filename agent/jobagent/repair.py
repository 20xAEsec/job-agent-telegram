"""Self-repair. A user's Claude fixes a bug in a throwaway git worktree of the UPSTREAM main branch, the user approves
the result in Telegram, and only then `publish` opens a pull request from the user's own GitHub fork.

Claude may run start, test and prepare. Only the app runs publish (after Approve) and discard. The rules that keep
this safe live here, in code, the same way `submit` is the one choke point for sending an application."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

UPSTREAM = "20xAEsec/job-agent-telegram"
UPSTREAM_URL = f"https://github.com/{UPSTREAM}.git"

# A fix may never touch these: the safety rules, the gate that sends or publishes, who is paired, the build and the
# dependency lists. A fix that needs one of them is a job for the maintainers, not for a bug-fixing task.
PROTECTED = (
    ".claude/", "CLAUDE.md", "scripts/", ".github/", ".gitattributes", ".gitignore",
    "app/src/review.ts", "app/src/tools.ts", "app/src/repair.ts",
    "agent/jobagent/submit.py", "agent/jobagent/safety.py", "agent/jobagent/pair.py", "agent/jobagent/accounts.py", "agent/jobagent/repair.py",
    "app/package.json", "app/bun.lock", "agent/pyproject.toml", "agent/uv.lock",
)
MAX_FILES, MAX_LINES = 10, 400
KEEP_DAYS = 7


class RepairError(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code


def _run(cmd: list[str], cwd=None, timeout: int = 300, env=None) -> tuple[int, str]:
    """Never a shell. A missing program or a timeout is a result, not a crash."""
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, env=env)
    except FileNotFoundError:
        return 127, f"{cmd[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, f"{cmd[0]}: timed out"
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _git(work: Path, *args: str, env=None) -> tuple[int, str]:
    """stdout only: git's warnings (line endings and the like) must never be read as data."""
    try:
        p = subprocess.run(["git", "-C", str(work), *args], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=120, env=env)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return 127, ""
    return p.returncode, p.stdout


# ---- privacy: what must never leave this computer ----
_PATTERNS = [
    ("a bot token", re.compile(r"\bbot\d+:[\w-]+|\b\d{6,}:[A-Za-z0-9_-]{30,}"), "<removed>"),
    ("an API key", re.compile(r"\bgh[pousr]_\w{20,}|\bsk-[\w-]{20,}"), "<removed>"),
    ("an email address", re.compile(r"[\w.+-]+@(?!example\.(?:com|org)\b|users\.noreply\.github\.com\b)[\w-]+(?:\.[\w-]+)+"), "<removed>"),
    ("a folder under your user name", re.compile(r"[A-Za-z]:\\Users\\[^\\\s]+|/Users/[^/\s]+|/home/[^/\s]+"), "~"),
]
_PROFILE_LINE = re.compile(r"^- (?:full_name|email|phone|location|linkedin|portfolio):\s*(\S.*)$", re.M)


def _personal(d: Path) -> list[str]:
    try:
        text = (d / "profile.md").read_text(encoding="utf-8")
    except OSError:
        return []
    return [v.strip() for v in _PROFILE_LINE.findall(text) if len(v.strip()) >= 4]


def scrub(d: Path, text: str) -> str:
    for _, pat, repl in _PATTERNS:
        text = pat.sub(repl, text)
    for v in _personal(d):
        text = re.sub(re.escape(v), "<removed>", text, flags=re.I)
    return text


def find_private(d: Path, text: str) -> str | None:
    """What kind of private detail `text` still holds, or None. Never returns the value itself."""
    for label, pat, _ in _PATTERNS:
        if pat.search(text):
            return label
    low = text.lower()
    return "something from your profile" if any(v.lower() in low for v in _personal(d)) else None


# ---- helpers ----
def _dir(d: Path, rid: str) -> Path:
    if not re.fullmatch(r"[\w-]{1,40}", rid):
        raise RepairError("bad_id", "bad repair id")
    return d / "repair" / rid


def _work(d: Path, rid: str) -> tuple[Path, Path]:
    dd = _dir(d, rid)
    if not (dd / "work" / ".git").exists():
        raise RepairError("no_work", "There is no repair in progress for this task. Run `repair start` first.")
    return dd, dd / "work"


def _read(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _tree(work: Path) -> str:
    """Hash of everything in the worktree: if it changes after the tests ran, the tests no longer vouch for it."""
    _git(work, "add", "-A")
    return _git(work, "write-tree")[1].strip()


def _report(dd: Path) -> dict:
    r = _read(dd / "report.json")
    for k, mx in (("title", 100), ("summary", 600), ("body", 4000)):
        v = r.get(k)
        if not isinstance(v, str) or not v.strip() or len(v) > mx:
            raise RepairError("bad_report", f"report.json needs a '{k}' of 1 to {mx} characters.")
    return r


def _digest(head: str, r: dict) -> str:
    return hashlib.sha256(f"{head}\n{r['title']}\n{r['body']}".encode()).hexdigest()


def _tail(p: Path, n: int) -> str:
    try:
        return "\n".join(p.read_text(encoding="utf-8", errors="replace").splitlines()[-n:])
    except OSError:
        return ""


# ---- the steps ----
def start(d: Path, rid: str) -> dict:
    dd = _dir(d, rid)
    root = d.parent
    if not (root / ".git").exists():
        raise RepairError("not_git", "This copy of JobAgent was downloaded as a ZIP, so I can't prepare a fix. "
                          "Install it with git clone (see the README) to use this.")
    if _run(["gh", "--version"])[0] == 127:
        raise RepairError("no_gh", "I need the GitHub command-line tool to share a fix. Install it from cli.github.com, "
                          "then run 'gh auth login' in a terminal.")
    rc, out = _run(["gh", "api", "user", "-q", ".login"])
    if rc != 0 or not out.strip():
        raise RepairError("no_login", "You're not logged in to GitHub on this computer. Run 'gh auth login' in a terminal, then try again.")
    login = out.strip().splitlines()[-1]
    _gc(d)
    work = dd / "work"
    if not work.exists():
        rc, out = _run(["git", "-C", str(root), "fetch", "--quiet", UPSTREAM_URL, "main"], timeout=120)
        if rc != 0:
            raise RepairError("offline", "I couldn't download the latest version of JobAgent from GitHub. Check your connection and try again.")
        dd.mkdir(parents=True, exist_ok=True)
        rc, out = _run(["git", "-C", str(root), "worktree", "add", "-q", "-b", f"repair/{rid}", str(work), "FETCH_HEAD"])
        if rc != 0:
            raise RepairError("no_worktree", "I couldn't set up a place to work on the fix.")
    logs = "\n".join(f"=== {n} (last 300 lines, private details removed) ===\n{scrub(d, _tail(d / 'logs' / n, 300))}"
                     for n in ("app.log", "agent.log"))
    (dd / "logs.txt").write_text(logs, encoding="utf-8")
    (dd / "meta.json").write_text(json.dumps({"login": login, "at": time.time()}), encoding="utf-8")
    base = f"{d.name}/repair/{rid}"
    return {"ok": True, "work": f"{base}/work", "logs": f"{base}/logs.txt", "report": f"{base}/report.json"}


def _gc(d: Path) -> None:
    base = d / "repair"
    if not base.is_dir():
        return
    for p in base.iterdir():
        if p.is_dir() and time.time() - p.stat().st_mtime > KEEP_DAYS * 86400:
            discard(d, p.name)


def test(d: Path, rid: str) -> dict:
    dd, work = _work(d, rid)
    rc, out = _run(["bun", "install", "--frozen-lockfile"], cwd=work / "app", timeout=600)
    if rc == 0:
        rc, out = _run(["bun", "test"], cwd=work / "app", timeout=600)
    app = {"ok": rc == 0, "tail": out[-1500:]}
    rc, out = _run(["uv", "run", "--quiet", "--frozen", "--project", "agent", "pytest", "-q"], cwd=work, timeout=900)
    agent = {"ok": rc == 0, "tail": out[-1500:]}
    ok = app["ok"] and agent["ok"]
    (dd / "tested.json").write_text(json.dumps({"ok": ok, "tree": _tree(work)}), encoding="utf-8")
    return {"ok": ok, "code": "" if ok else "tests_failed", "app": app, "agent": agent,
            **({} if ok else {"error": "The tests do not pass."})}


def prepare(d: Path, rid: str) -> dict:
    dd, work = _work(d, rid)
    r = _report(dd)
    tested = _read(dd / "tested.json")
    if not tested.get("ok") or tested.get("tree") != _tree(work):
        raise RepairError("untested", "Run `repair test` on the final version of the fix first, and it has to pass.")
    names = [n for n in _git(work, "diff", "--cached", "--name-only")[1].splitlines() if n]
    if not names:
        raise RepairError("no_change", "There is nothing changed to propose.")
    for n in names:
        if any(n == p or (p.endswith("/") and n.startswith(p)) for p in PROTECTED):
            raise RepairError("protected", f"A fix may not change {n}: that is for the maintainers.")
    stat = [ln.split("\t") for ln in _git(work, "diff", "--cached", "--numstat")[1].splitlines()]
    if any(s[0] == "-" for s in stat):
        raise RepairError("binary", "A fix may not include binary files.")
    added, removed = sum(int(s[0]) for s in stat), sum(int(s[1]) for s in stat)
    if len(names) > MAX_FILES or added + removed > MAX_LINES:
        raise RepairError("too_big", f"The change is too large for an automatic fix (limit {MAX_FILES} files, {MAX_LINES} lines).")
    diff = _git(work, "diff", "--cached", "-U0")[1]
    plus = "\n".join(ln for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
    kind = find_private(d, plus + "\n" + json.dumps(r))
    if kind:
        raise RepairError("private", f"The fix or its notes contain {kind}. Remove it and try again.")
    login = _read(dd / "meta.json").get("login", "user")
    email = f"{login}@users.noreply.github.com"
    env = {**os.environ, "GIT_AUTHOR_NAME": login, "GIT_COMMITTER_NAME": login, "GIT_AUTHOR_EMAIL": email, "GIT_COMMITTER_EMAIL": email}
    if _git(work, "commit", "-q", "-m", r["title"], env=env)[0] != 0:
        raise RepairError("commit_failed", "I couldn't save the fix.")
    head = _git(work, "rev-parse", "HEAD")[1].strip()
    prop = {"title": r["title"], "summary": r["summary"], "body": r["body"], "files": names, "added": added,
            "removed": removed, "login": login, "head": head, "hash": _digest(head, r)}
    (dd / "proposal.json").write_text(json.dumps(prop), encoding="utf-8")
    return {"ok": True, **{k: prop[k] for k in ("title", "files", "added", "removed")}}


def publish(d: Path, rid: str) -> dict:
    """Only the app calls this, after the user pressed Approve (which wrote approved.json)."""
    dd, work = _work(d, rid)
    prop, approved = _read(dd / "proposal.json"), _read(dd / "approved.json")
    if not prop or not approved:
        raise RepairError("not_approved", "This fix was not approved.")
    r = _report(dd)
    head = _git(work, "rev-parse", "HEAD")[1].strip()
    if not (prop["hash"] == approved.get("hash") == _digest(head, r)) or _git(work, "status", "--porcelain")[1].strip():
        raise RepairError("changed", "The fix changed after you approved it. Nothing was sent.")
    login, name, branch = prop["login"], UPSTREAM.split("/")[1], f"repair/{rid}"
    rc, out = _run(["gh", "repo", "fork", UPSTREAM, "--clone=false"], timeout=120)
    if rc != 0 and "already exists" not in out:
        raise RepairError("fork_failed", "I couldn't make your copy of the project on GitHub.")
    # one-off credential helper: no change to the user's global git config
    rc, out = _run(["git", "-C", str(work), "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
                    "push", "-q", f"https://github.com/{login}/{name}.git", f"HEAD:refs/heads/{branch}"], timeout=180)
    if rc != 0:
        raise RepairError("push_failed", "I couldn't upload the fix to GitHub.")
    (dd / "body.md").write_text(r["body"] + "\n\n---\nOpened by JobAgent's repair task after the user approved it.\n", encoding="utf-8")
    rc, out = _run(["gh", "pr", "create", "--repo", UPSTREAM, "--head", f"{login}:{branch}", "--base", "main",
                    "--title", r["title"], "--body-file", str(dd / "body.md")], timeout=120)
    if rc != 0:
        raise RepairError("pr_failed", "I uploaded the fix but couldn't open the pull request.")
    url = out.strip().splitlines()[-1]
    discard(d, rid)
    return {"ok": True, "url": url}


def discard(d: Path, rid: str) -> dict:
    dd = _dir(d, rid)
    root = d.parent
    if (dd / "work").exists():
        _run(["git", "-C", str(root), "worktree", "remove", "--force", str(dd / "work")])
        _run(["git", "-C", str(root), "branch", "-D", f"repair/{rid}"])
    shutil.rmtree(dd, ignore_errors=True)
    return {"ok": True}


def run(d: Path, op: str, rid: str) -> dict:
    return {"start": start, "test": test, "prepare": prepare, "publish": publish, "discard": discard}[op](d, rid)
