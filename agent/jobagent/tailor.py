"""Job-level resume and cover-letter commands: `resume outline`, `resume-check`, `tailor <id>`, `cover-letter <id>`."""
import json
import shutil
from pathlib import Path

import docx

from . import profile
from .docs import docx_tailor, pdf_tailor, render, verify
from .docs.plan import DocError, diff
from .paths import atomic_write_json
from .profile import JOB_RE

MAX_WORDS = 250


def _tailoring(d: Path) -> str:
    try:
        return json.loads((d / "settings.json").read_text("utf-8"))["apply"]["tailoring"]
    except (OSError, KeyError, ValueError):
        return "light"


def _base(d: Path) -> Path:
    for ext in (".docx", ".pdf"):
        if (d / f"base_resume{ext}").exists():
            return d / f"base_resume{ext}"
    raise DocError("no_resume", "no base resume yet: the user must send one first")


def _job_dir(d: Path, job_id: str) -> Path:
    if not JOB_RE.match(job_id):
        raise DocError("bad_job_id", "job id must match [a-z0-9-]{1,80}")
    j = d / "jobs" / job_id
    j.mkdir(parents=True, exist_ok=True)
    return j


def outline(d: Path) -> dict:
    b = _base(d)
    mod = docx_tailor if b.suffix == ".docx" else pdf_tailor
    units = mod.outline(b, _tailoring(d))
    for u in units:  # layout details are for the tailor, not for Claude
        for k in ("bbox", "prefix", "font", "size", "color", "page"):
            u.pop(k, None)
    return {"ok": True, "format": b.suffix[1:], "tailoring": _tailoring(d), "units": units}


def _base_pdf(d: Path, b: Path) -> Path:
    if b.suffix == ".pdf":
        return b
    out = d / "tmp" / "base_render.pdf"
    if not out.exists() or out.stat().st_mtime < b.stat().st_mtime:
        render.docx_to_pdf(b, out)
    return out


def _run(d: Path, out_dir: Path, plan: dict, stem: str = "resume") -> dict:
    """Apply `plan` to the base resume into out_dir, then verify. Returns the files and the verify report."""
    b, t = _base(d), _tailoring(d)
    units = (docx_tailor if b.suffix == ".docx" else pdf_tailor).outline(b, t)
    by = {u["uid"]: u for u in units}
    edits = [{"old": by[e["uid"]]["text"], "new": e["new_text"]} for e in plan.get("edits") or [] if e.get("uid") in by]
    for r in plan.get("reorder") or []:  # moved paragraphs: mask both old and new positions
        edits += [{"old": by[i]["text"], "new": by[i]["text"]} for i in r.get("uids", []) if i in by]
    if b.suffix == ".docx":
        docx_tailor.apply(b, plan, out_dir / f"{stem}.docx", t)
        render.docx_to_pdf(out_dir / f"{stem}.docx", out_dir / f"{stem}.pdf")
        v = verify.verify(_base_pdf(d, b), out_dir / f"{stem}.pdf", edits)
    else:
        res = pdf_tailor.apply(b, plan, out_dir / f"{stem}.pdf", t)
        v = verify.verify(b, out_dir / f"{stem}.pdf", [{**e, **x} for e, x in zip(edits, res["edited"])], res["overflow"])
    return {"units": units, "verify": v}


def tailor(d: Path, job_id: str, fallback: bool = False) -> dict:
    j = _job_dir(d, job_id)
    b = _base(d)
    if fallback:  # verify kept failing: use the base resume as is and say so in the review
        shutil.copyfile(b, j / f"resume{b.suffix}")
        if b.suffix == ".docx":
            render.docx_to_pdf(b, j / "resume.pdf")
        atomic_write_json(j / "diff.json", {"edits": [], "reorder": [], "fallback": True})
        return {"ok": True, "fallback": True, "files": sorted(p.name for p in j.glob("resume.*"))}
    try:
        plan = json.loads((j / "tailor_plan.json").read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise DocError("no_plan", f"tailor_plan.json is missing or not valid JSON ({type(e).__name__})") from e
    r = _run(d, j, plan)
    atomic_write_json(j / "diff.json", {**diff(r["units"], plan), "verify": r["verify"]})
    files = sorted(p.name for p in j.glob("resume.*"))
    if not r["verify"]["ok"]:
        return {"ok": False, "code": "verify_failed", "error": "; ".join(c["detail"] for c in r["verify"]["checks"] if not c["ok"]), "verify": r["verify"], "files": files}
    return {"ok": True, "edits": len(plan.get("edits") or []), "verify": r["verify"], "files": files}


def resume_check(d: Path) -> dict:
    """Zero-edit round trip of the base resume, so the user can confirm the converter keeps it looking right."""
    t = d / "tmp"
    t.mkdir(parents=True, exist_ok=True)
    r = _run(d, t, {}, "resume_check")
    pdf = t / "resume_check.pdf"
    png = t / "resume_check.png"
    png.write_bytes(render.page_png(pdf))
    return {"ok": r["verify"]["ok"], "pdf": str(pdf.resolve()), "png": str(png.resolve()), "verify": r["verify"],
            **({} if r["verify"]["ok"] else {"code": "verify_failed", "error": "the resume does not survive conversion unchanged"})}


def cover_letter(d: Path, job_id: str) -> dict:
    j = _job_dir(d, job_id)
    try:
        body = (j / "cover_letter.md").read_text("utf-8").strip()
    except OSError as e:
        raise DocError("no_letter", "cover_letter.md is missing") from e
    words = len(body.split())
    if not 0 < words <= MAX_WORDS:
        raise DocError("bad_letter", f"cover letter is {words} words: must be 1 to {MAX_WORDS}")
    f = profile.show(d, "Contact")["fields"]
    base = _base(d)
    font = "Calibri"
    if base.suffix == ".docx":
        runs = [r for p in docx.Document(str(base)).paragraphs for r in p.runs if r.font.name]
        font = runs[0].font.name if runs else font
    doc = docx.Document()
    doc.styles["Normal"].font.name = font
    doc.add_paragraph().add_run(f.get("full_name", "")).bold = True
    doc.add_paragraph("  |  ".join(x for x in (f.get("email"), f.get("phone"), f.get("location")) if x))
    for para in body.split("\n\n"):
        doc.add_paragraph(" ".join(para.split()))
    doc.save(str(j / "cover_letter.docx"))
    render.docx_to_pdf(j / "cover_letter.docx", j / "cover_letter.pdf")
    return {"ok": True, "words": words, "files": ["cover_letter.docx", "cover_letter.pdf"]}
