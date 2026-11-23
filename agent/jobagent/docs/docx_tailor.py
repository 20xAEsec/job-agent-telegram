"""DOCX: units are body paragraphs (uid = index into doc.paragraphs). Edits keep the first run's formatting."""
from pathlib import Path

import docx
from lxml import etree

from .plan import BULLETS, check_plan, is_heading, max_chars, section_kind


def _label(p) -> bool:
    """A bold lead-in run ("Languages: ") in front of plain text is kept as is; only the text after it is edited."""
    r = p.runs
    return len(r) >= 2 and bool(r[0].bold) and not r[1].bold and 0 < len(r[0].text) <= 80


def _editable_text(p) -> str:
    return "".join(r.text for r in p.runs[1:]) if _label(p) else p.text


def outline(path: Path, tailoring: str = "light") -> list[dict]:
    units, section = [], ""
    for i, p in enumerate(docx.Document(str(path)).paragraphs):
        text = p.text.strip()
        if not text:
            continue
        bold = bool(p.runs) and all(r.bold for r in p.runs if r.text.strip())
        if is_heading(text, bold) or p.style.name.lower().startswith("heading"):
            section, kind = text, "heading"
        else:
            listed = p.style.name.lower().startswith("list") or p._p.pPr is not None and p._p.pPr.numPr is not None or text[0] in BULLETS
            kind = section_kind(section) or ("bullet" if listed else "other")
            if kind == "skills" and not _label(p) and listed:
                kind = "bullet"
        t = _editable_text(p).strip() if kind in ("summary", "bullet", "skills") else text
        units.append({"uid": i, "section": section, "kind": kind, "text": t, "char_len": len(t), "max_chars": max_chars(len(t), tailoring)})
    return units


def _set_text(p, text: str) -> None:
    keep = 1 if _label(p) else 0
    p.runs[keep].text = text
    for r in p.runs[keep + 1:]:
        r._r.getparent().remove(r._r)


def _reorder(paras, uids: list[int]) -> None:
    """Put the paragraphs in `uids` order, using the slots the same paragraphs occupy now."""
    els = [paras[u]._p for u in uids]
    slots = sorted(els, key=lambda e: e.getparent().index(e))
    marks = []
    for s in slots:
        m = etree.Element("mark")
        s.addprevious(m)
        marks.append(m)
    for e in els:
        e.getparent().remove(e)
    for m, e in zip(marks, els):
        m.addprevious(e)
        m.getparent().remove(m)


def apply(src: Path, plan: dict, dst: Path, tailoring: str = "light") -> None:
    check_plan(outline(src, tailoring), plan, tailoring)
    d = docx.Document(str(src))
    paras = list(d.paragraphs)
    for e in plan.get("edits") or []:
        _set_text(paras[e["uid"]], e["new_text"])
    for r in plan.get("reorder") or []:
        _reorder(paras, r["uids"])
    d.save(str(dst))
