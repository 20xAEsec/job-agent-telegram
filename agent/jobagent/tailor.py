"""Job-level resume and cover-letter commands: `resume outline`, `resume bank`, `resume-check`, `tailor <id>`, `cover-letter <id>`."""
import json
import re
import shutil
from pathlib import Path

import docx
import pymupdf

from . import profile, resume
from .docs import ats, docx_tailor, pdf_tailor, render, verify
from .docs.plan import LIMIT, DocError, diff
from .paths import atomic_write_json
from .profile import JOB_RE

MAX_WORDS = 250


FACT_SECTIONS = ("Summary", "Experience", "Skills", "Confirmed skills", "Achievements", "Education")  # never Saved answers


def _settings(d: Path) -> dict:
    try:
        return json.loads((d / "settings.json").read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def _tailoring(d: Path) -> str:
    t = (_settings(d).get("apply") or {}).get("tailoring")
    return t if t in (*LIMIT, "ats") else "light"


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
    if _tailoring(d) == "ats":  # the rebuild works from the line bank, not the layout
        return {"ok": True, "format": b.suffix[1:], "tailoring": "ats", "next": "jobagent resume bank"}
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
    b, t = _base(d), _tailoring(d) if _tailoring(d) in LIMIT else "light"  # ats mode: a zero-edit resume-check round trip
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
    if _tailoring(d) == "ats":
        return _ats(d, j, plan)
    r = _run(d, j, plan)
    atomic_write_json(j / "diff.json", {**diff(r["units"], plan), "verify": r["verify"]})
    files = sorted(p.name for p in j.glob("resume.*"))
    if not r["verify"]["ok"]:
        return {"ok": False, "code": "verify_failed", "error": "; ".join(c["detail"] for c in r["verify"]["checks"] if not c["ok"]), "verify": r["verify"], "files": files}
    return {"ok": True, "edits": len(plan.get("edits") or []), "verify": r["verify"], "files": files}


def _texts(d: Path) -> dict[str, str]:
    srcs = resume.sources(d)
    if not srcs:
        raise DocError("no_resume", "no base resume yet: the user must send one first")
    return {s["name"]: Path(s["text_file"]).read_text("utf-8") for s in srcs}


def _read_bank(d: Path, texts: dict) -> dict:
    try:
        bank = json.loads((d / "resume_bank.json").read_text("utf-8"))
    except OSError as e:
        raise DocError("no_bank", "resume_bank.json is missing: run `jobagent resume bank` and build it") from e
    except ValueError:
        bank = None
    if errs := ats.check_bank(bank, list(texts.values())):
        raise DocError("bad_bank", "; ".join(errs[:8]))
    return bank


def bank_status(d: Path) -> dict:
    """Whether data/resume_bank.json (every line item from every resume version) is there and still true to the resumes."""
    texts, srcs = _texts(d), resume.sources(d)
    if not (d / "resume_bank.json").exists():
        return {"ok": True, "status": "missing", "bank_file": str((d / "resume_bank.json").resolve()), "sources": srcs}
    bank = _read_bank(d, texts)
    return {"ok": True, "status": "ready", "versions": len(srcs), "roles": len(bank["roles"]),
            "bullets": sum(len(r["bullets"]) for r in bank["roles"]), "skills": len(bank.get("skills") or [])}


def _paper(b: Path) -> pymupdf.Rect:
    """The ATS rebuild keeps the user's paper size (Letter or A4)."""
    if b.suffix == ".pdf":
        with pymupdf.open(b) as x:
            return x[0].rect
    s = docx.Document(str(b)).sections[0]
    return pymupdf.Rect(0, 0, s.page_width.pt, s.page_height.pt) if s.page_width and s.page_height else pymupdf.paper_rect("letter")


def _ats(d: Path, j: Path, plan: dict) -> dict:
    texts = _texts(d)
    bank = _read_bank(d, texts)
    secs = profile.show(d)["sections"] if (d / "profile.md").exists() else {}
    facts = "\n".join([*texts.values(), *(secs.get(k, "") for k in FACT_SECTIONS)])
    ach = {k: v for k, v in profile._fields(secs.get("Achievements", "").splitlines()).items() if re.fullmatch(r"a\d{1,2}", k) and v.strip()}
    try:
        an = json.loads((j / "analysis.json").read_text("utf-8"))
    except (OSError, ValueError):
        an = {}
    kws, years = ats.keywords(an), (_settings(d).get("filters") or {}).get("years_experience")
    ats.check_plan(plan, bank, kws, facts, ach, [years] if isinstance(years, int) else [])
    contact = profile._fields(secs.get("Contact", "").splitlines())
    r = ats.compose(plan, bank, contact, ach, j / "resume.pdf", _paper(_base(d)))
    (j / "resume.docx").unlink(missing_ok=True)  # left from an earlier non-ATS run: the PDF is the resume now
    src = {b["id"]: b["text"] for x in bank["roles"] for b in x["bullets"]} | ach
    picked = [b for x in plan["roles"] for b in x.get("bullets", [])]
    edits = [{"old": src[b["src"]], "new": b["text"], "reason": b.get("reason", "")} for b in picked if ats.norm(b["text"]) != ats.norm(src[b["src"]])]
    sq = {n: ats._sq(t) for n, t in texts.items()}
    used = sorted({n for b in picked for n, t in sq.items() if ats._sq(src[b["src"]]) in t})
    atomic_write_json(j / "diff.json", {"mode": "ats", "edits": edits, "reorder": [], "versions_used": used, "versions_total": len(texts),
                                        "pages": r["pages"], "verify": r["verify"]})
    res = {"ok": True, "mode": "ats", "pages": r["pages"], "font_pt": r["font_pt"], "reworded": len(edits), "versions_used": used, "files": ["resume.pdf"]}
    if kws:
        after, fn = ats.score(r["text"], kws), ats.norm(facts)
        res["keywords"] = {"before": ats.score(texts.get("main", ""), kws)["score"], "after": after["score"],
                           # missing ones the user's own resumes back can still be added; the others are true gaps
                           "missing_you_have": [m for m in after["missing"] if ats.backed(m, fn, kws)],
                           "missing_not_on_your_resumes": [m for m in after["missing"] if not ats.backed(m, fn, kws)]}
    if not r["verify"]["ok"]:
        return {**res, "ok": False, "code": "verify_failed", "error": "; ".join(c["detail"] for c in r["verify"]["checks"] if not c["ok"]), "verify": r["verify"]}
    return res


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
