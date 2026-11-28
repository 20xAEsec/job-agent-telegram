"""profile.md: human-readable, machine-parsed. Only the parts we change are rewritten; the rest stays byte-identical."""
import re
from datetime import date

from .paths import atomic_write_text

SAVED = "Saved answers"
KEPT = ("Confirmed skills", "Achievements", SAVED)  # told by the user, not read from the resume ("Achievements" is the fact bank)
SAVED_NOTE = "<!-- Managed by JobAgent. Edit from Telegram (Profile & answers) or carefully by hand. -->\n"
KEY_RE = re.compile(r"^[a-z0-9_]{1,40}$")
JOB_RE = re.compile(r"^[a-z0-9-]{1,80}$")
# Defense in depth: these must never be auto-filled (DESIGN 4.4 "unusual"), so never store them.
NEVER_SAVE = re.compile(r"ssn|social_security|national_id|passport|bank|iban|routing|password|passcode", re.I)
FIELD_RE = re.compile(r"^- (\w+):[ \t]?(.*?)\r?\n?$")


class ProfileError(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code


def _path(data_dir):
    return data_dir / "profile.md"


def _read(data_dir) -> str | None:
    p = _path(data_dir)
    return p.read_bytes().decode("utf-8") if p.exists() else None


def _esc(v: str) -> str:
    v = v.strip().replace("\\", "\\\\").replace("\r\n", "\n").replace("\r", "\n")
    return v.replace("\n", "\\n")


def _unesc(v: str) -> str:
    return re.sub(r"\\(n|\\)", lambda m: "\n" if m[1] == "n" else "\\", v)


def split_sections(text: str):
    """-> [(heading | None, [lines])]. The first entry is the preamble. ''.join of all lines == text."""
    out = [(None, [])]
    for line in text.splitlines(keepends=True):
        m = re.match(r"^## (?!#)(.*?)\r?\n?$", line)
        if m:
            out.append((m[1].strip(), [line]))
        else:
            out[-1][1].append(line)
    return out


def _fields(lines) -> dict:
    return {m[1]: m[2] for m in (FIELD_RE.match(l) for l in lines) if m}


def _blocks(body_lines):
    """Saved answers body -> (lines before the first ###, [(key, raw_lines)])."""
    pre, blocks = [], []
    for line in body_lines:
        m = re.match(r"^### (.+?)\r?\n?$", line)
        if m:
            blocks.append((m[1].strip(), [line]))
        elif blocks:
            blocks[-1][1].append(line)
        else:
            pre.append(line)
    return pre, blocks


def _entry(key, lines) -> dict:
    f = _fields(lines[1:])
    scope = f.get("scope", "global")
    return {
        "key": key,
        "base_key": key.split("__", 1)[1] if scope == "job" and "__" in key else key,
        "question": _unesc(f.get("question", "")),
        "answer": _unesc(f.get("answer", "")),
        "sensitive": f.get("sensitive", "false") == "true",
        "scope": scope,
        "job": f.get("source_job", "") if scope == "job" else "",
        "source_job": f.get("source_job", ""),
        "updated": f.get("updated", ""),
    }


def _render(key, question, value, scope, source_job, sensitive) -> list[str]:
    rows = [f"### {key}\n", f"- question: {_esc(question)}\n", f"- answer: {_esc(value)}\n",
            f"- sensitive: {'true' if sensitive else 'false'}\n", f"- scope: {scope}\n"]
    if source_job:
        rows.append(f"- source_job: {source_job}\n")
    rows.append(f"- updated: {date.today().isoformat()}\n")
    return rows


def _load(data_dir):
    text = _read(data_dir)
    if text is None:
        text = f"# Profile\n\n## {SAVED}\n{SAVED_NOTE}"
    secs = split_sections(text)
    idx = next((i for i, (h, _) in enumerate(secs) if h == SAVED), None)
    if idx is None:
        if secs[-1][1] and not secs[-1][1][-1].endswith("\n"):
            secs[-1][1][-1] += "\n"
        secs.append((SAVED, [f"## {SAVED}\n", SAVED_NOTE]))
        idx = len(secs) - 1
    return secs, idx


def _save(data_dir, secs):
    atomic_write_text(_path(data_dir), "".join("".join(ls) for _, ls in secs))


def _with_blocks(secs, idx, pre, blocks):
    head = secs[idx][1][0]
    secs[idx] = (SAVED, [head] + pre + [l for _, ls in blocks for l in ls])


def answer_list(data_dir, include_job=None) -> dict:
    secs, idx = _load(data_dir)
    _, blocks = _blocks(secs[idx][1][1:])
    entries = [_entry(k, ls) for k, ls in blocks]
    return {"ok": True, "answers": [e for e in entries if e["scope"] == "global" or (include_job and e["job"] == include_job)]}


def answer_get(data_dir, key) -> dict:
    for e in answer_list(data_dir, include_job=key.split("__", 1)[0] if "__" in key else None)["answers"]:
        if e["key"] == key:
            return {"ok": True, "answer": e}
    raise ProfileError("not_found", f"no saved answer '{key}'")


def answer_set(data_dir, base_key, question, value, scope="global", job=None, sensitive=False) -> dict:
    if not KEY_RE.match(base_key):
        raise ProfileError("bad_key", "key must match [a-z0-9_]{1,40}")
    if NEVER_SAVE.search(base_key):
        raise ProfileError("never_save", "this kind of field must never be saved or auto-filled")
    if scope not in ("global", "job"):
        raise ProfileError("bad_scope", "scope must be global or job")
    if job is not None and not JOB_RE.match(job):
        raise ProfileError("bad_job", "bad job id")
    if scope == "job" and not job:
        raise ProfileError("bad_job", "--job is required for scope job")
    key = f"{job}__{base_key}" if scope == "job" else base_key
    secs, idx = _load(data_dir)
    pre, blocks = _blocks(secs[idx][1][1:])
    rendered = _render(key, question, value, scope, job, sensitive)
    for i, (k, _) in enumerate(blocks):
        if k == key:
            blocks[i] = (k, rendered)
            break
    else:
        if blocks and not blocks[-1][1][-1].endswith("\n"):
            blocks[-1][1][-1] += "\n"
        elif not blocks and pre and not pre[-1].endswith("\n"):
            pre[-1] += "\n"
        blocks.append((key, rendered))
    _with_blocks(secs, idx, pre, blocks)
    _save(data_dir, secs)
    return {"ok": True, "key": key, "scope": scope}


def answer_delete(data_dir, key) -> dict:
    secs, idx = _load(data_dir)
    pre, blocks = _blocks(secs[idx][1][1:])
    kept = [(k, ls) for k, ls in blocks if k != key]
    if len(kept) == len(blocks):
        raise ProfileError("not_found", f"no saved answer '{key}'")
    _with_blocks(secs, idx, pre, kept)
    _save(data_dir, secs)
    return {"ok": True}


def show(data_dir, section=None) -> dict:
    text = _read(data_dir)
    if text is None:
        raise ProfileError("no_profile", "no profile yet (onboarding not done)")
    secs = {h: "".join(ls[1:]) for h, ls in split_sections(text) if h}
    if section is None:
        return {"ok": True, "sections": secs}
    if section not in secs:
        raise ProfileError("no_section", f"no section '{section}'")
    return {"ok": True, "section": section, "text": secs[section], "fields": _fields(secs[section].splitlines())}


def _contact_fields(secs) -> dict:
    return _fields(next((ls for h, ls in secs if h == "Contact"), []))


def write_draft(data_dir, draft_file) -> dict:
    with open(draft_file, "rb") as f:
        draft = f.read().decode("utf-8-sig")
    secs = split_sections(draft)
    names = [h for h, _ in secs if h]
    if not draft.lstrip().startswith("# Profile") or "Contact" not in names:
        raise ProfileError("bad_draft", "draft must start with '# Profile' and contain '## Contact'")
    old = _read(data_dir)
    for h, ls in split_sections(old or ""):
        if h in KEPT and h not in names:  # keep what the user already told us: a new resume never erases it
            if secs[-1][1] and not secs[-1][1][-1].endswith("\n"):
                secs[-1][1][-1] += "\n"
            secs.append((h, ls))
            names.append(h)
    links = _contact_fields(split_sections(old or ""))
    _save(data_dir, secs)
    new = _contact_fields(secs)
    for k in LINK_KEYS:  # a resume without a link never erases the one the user gave
        if links.get(k, "").strip() and not new.get(k, "").strip():
            set_field(data_dir, "Contact", k, links[k])
    return {"ok": True, "sections": names}


LINK_KEYS = ("linkedin", "github", "portfolio")
CONTACT_KEYS = ("full_name", "email", "phone", "location", *LINK_KEYS)


def set_field(data_dir, section, key, value) -> dict:
    """Set one `- key: value` line in a section (Contact fixes from Telegram). Other lines stay byte-identical."""
    if not re.match(r"^\w{1,40}$", key) or not re.match(r"^[A-Za-z][\w ]{0,40}$", section):
        raise ProfileError("bad_key", "bad section or key")
    value = " ".join(str(value).split())[:600]
    text = _read(data_dir)
    if text is None:
        raise ProfileError("no_profile", "no profile yet (onboarding not done)")
    secs = split_sections(text)
    idx = next((i for i, (h, _) in enumerate(secs) if h == section), None)
    if idx is None:
        at = next((i for i, (h, _) in enumerate(secs) if h == SAVED), len(secs))
        if secs[at - 1][1] and not secs[at - 1][1][-1].endswith("\n"):
            secs[at - 1][1][-1] += "\n"
        secs.insert(at, (section, [f"## {section}\n"]))
        idx = at
    lines = secs[idx][1]
    nl = "\r\n" if lines[0].endswith("\r\n") else "\n"
    new = f"- {key}: {value}{nl}"
    for i, line in enumerate(lines):
        m = FIELD_RE.match(line)
        if m and m[1] == key:
            lines[i] = new if line.endswith("\n") else new.rstrip("\r\n")
            break
    else:
        last = max((i for i, l in enumerate(lines) if FIELD_RE.match(l)), default=0)
        if not lines[last].endswith("\n"):
            lines[last] += nl
        lines.insert(last + 1, new)
    _save(data_dir, secs)
    return {"ok": True, "section": section, "key": key}
