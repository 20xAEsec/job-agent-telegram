import re
import shutil
from pathlib import Path

from .paths import atomic_write_text

MAX_VERSIONS = 6  # extra resume versions besides the main one; their lines feed the ATS rebuild
NAME_RE = re.compile(r"^[a-z0-9-]{1,40}$")


class ResumeError(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code


def _extract(path: Path) -> str:
    if path.suffix.lower() == ".docx":
        import docx

        d = docx.Document(str(path))
        parts = [p.text for p in d.paragraphs]
        parts += [c.text for t in d.tables for r in t.rows for c in r.cells]
        return "\n".join(parts)
    import pymupdf

    with pymupdf.open(path) as doc:
        return "\n".join(page.get_text() for page in doc)


def _vdir(data_dir: Path) -> Path:
    return data_dir / "resumes"


def versions(data_dir: Path) -> list[str]:
    d = _vdir(data_dir)
    return sorted(p.stem for p in d.glob("*.txt")) if d.is_dir() else []


def sources(data_dir: Path) -> list[dict]:
    """Every resume whose lines may go on a tailored resume: the main one first, then the extra versions."""
    main = data_dir / "resume_text.txt"
    out = [{"name": "main", "text_file": str(main.resolve())}] if main.exists() else []
    return out + [{"name": n, "text_file": str((_vdir(data_dir) / f"{n}.txt").resolve())} for n in versions(data_dir)]


def _drop_bank(data_dir: Path) -> None:
    (data_dir / "resume_bank.json").unlink(missing_ok=True)  # its lines came from the old set of resumes: rebuild


def import_resume(data_dir: Path, src, version: bool = False) -> dict:
    """Store the original as data/base_resume.<ext> (never modified) and its text as data/resume_text.txt.
    version=True stores an extra version under data/resumes/ instead; the main resume and profile stay as they are."""
    src = Path(src)
    ext = src.suffix.lower()
    if ext not in (".pdf", ".docx") or not src.is_file():
        raise ResumeError("bad_file", "expected an existing .pdf or .docx file")
    try:
        text = _extract(src).strip()
    except Exception as e:  # noqa: BLE001 - corrupt file: report the type only, no content
        raise ResumeError("unreadable", f"could not read the file ({type(e).__name__})") from e
    data_dir.mkdir(parents=True, exist_ok=True)
    if version:
        if not text:
            raise ResumeError("no_text", "no text found in that file (scanned PDF?)")
        have = versions(data_dir)
        if len(have) >= MAX_VERSIONS:
            raise ResumeError("too_many", f"at most {MAX_VERSIONS} extra versions: remove one first")
        base = re.sub(r"[^a-z0-9]+", "-", re.sub(r"^\d+-", "", src.stem).lower()).strip("-")[:36] or "version"  # inbox names are "<ms>-<name>"
        name, i = base, 2
        while name in have:
            name, i = f"{base}-{i}", i + 1
        _vdir(data_dir).mkdir(exist_ok=True)
        shutil.copyfile(src, _vdir(data_dir) / f"{name}{ext}")
        atomic_write_text(_vdir(data_dir) / f"{name}.txt", text + "\n")
        _drop_bank(data_dir)
        return {"ok": True, "version": name, "versions": versions(data_dir), "chars": len(text)}
    for e in (".pdf", ".docx"):
        (data_dir / f"base_resume{e}").unlink(missing_ok=True)
    dst = data_dir / f"base_resume{ext}"
    shutil.copyfile(src, dst)
    atomic_write_text(data_dir / "resume_text.txt", text + "\n")
    _drop_bank(data_dir)
    res = {"ok": True, "resume": str(dst), "text_file": str(data_dir / "resume_text.txt"), "chars": len(text)}
    if not text:
        res["warning"] = "no text found (scanned PDF?). Ask the user for a text-based PDF or a DOCX."
    return res


def remove_version(data_dir: Path, name: str) -> dict:
    if not NAME_RE.match(name) or name not in versions(data_dir):
        raise ResumeError("no_version", f"no resume version named {name!r:.50}")
    for e in (".pdf", ".docx", ".txt"):
        (_vdir(data_dir) / f"{name}{e}").unlink(missing_ok=True)
    _drop_bank(data_dir)
    return {"ok": True, "versions": versions(data_dir)}
