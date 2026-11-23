import shutil
from pathlib import Path

from .paths import atomic_write_text


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


def import_resume(data_dir: Path, src) -> dict:
    """Store the original as data/base_resume.<ext> (never modified) and its text as data/resume_text.txt."""
    src = Path(src)
    ext = src.suffix.lower()
    if ext not in (".pdf", ".docx") or not src.is_file():
        raise ResumeError("bad_file", "expected an existing .pdf or .docx file")
    try:
        text = _extract(src).strip()
    except Exception as e:  # noqa: BLE001 - corrupt file: report the type only, no content
        raise ResumeError("unreadable", f"could not read the file ({type(e).__name__})") from e
    data_dir.mkdir(parents=True, exist_ok=True)
    for e in (".pdf", ".docx"):
        (data_dir / f"base_resume{e}").unlink(missing_ok=True)
    dst = data_dir / f"base_resume{ext}"
    shutil.copyfile(src, dst)
    atomic_write_text(data_dir / "resume_text.txt", text + "\n")
    res = {"ok": True, "resume": str(dst), "text_file": str(data_dir / "resume_text.txt"), "chars": len(text)}
    if not text:
        res["warning"] = "no text found (scanned PDF?). Ask the user for a text-based PDF or a DOCX."
    return res
