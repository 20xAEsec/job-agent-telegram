"""PDF: units are text blocks. An edited unit is redacted and its new text is drawn in the same box, size and color."""
from pathlib import Path

import pymupdf

from .plan import BULLETS, DocError, check_plan, is_heading, max_chars, section_kind

FONTS_DIR = Path(__file__).resolve().parents[2] / "fonts"  # downloaded by setup; gitignored
# DESIGN 8.3 metric-compatible substitutes (used only if the files exist in agent/fonts/).
SUBSTITUTES = {"calibri": "Carlito", "cambria": "Caladea", "arial": "LiberationSans", "helvetica": "LiberationSans",
               "times": "LiberationSerif", "georgia": "Gelasio", "garamond": "EBGaramond"}


def _blocks(page):
    for b in page.get_text("dict")["blocks"]:
        spans = [s for l in b.get("lines", []) for s in l["spans"] if s["text"].strip()]
        if spans:
            yield b, spans


def outline(path: Path, tailoring: str = "light") -> list[dict]:
    units, section, uid = [], "", 0
    with pymupdf.open(path) as doc:
        for pno, page in enumerate(doc):
            for b, spans in _blocks(page):
                text = " ".join(" ".join(s["text"] for s in l["spans"]).strip() for l in b["lines"]).strip()
                first = spans[0]
                bold = bool(first["flags"] & 16) or "bold" in first["font"].lower()
                lead = text[0] in BULLETS and len(text) > 1 and text[1] == " "
                if is_heading(text, bold):
                    section, kind = text, "heading"
                else:
                    kind = section_kind(section) or ("bullet" if lead or len(text) > 60 else "other")
                body = text[2:].strip() if lead else text
                units.append({
                    "uid": uid, "section": section, "kind": kind, "text": body, "char_len": len(body), "max_chars": max_chars(len(body), tailoring),
                    "page": pno, "bbox": list(b["bbox"]), "prefix": text[:2] if lead else "", "font": first["font"], "size": first["size"], "color": first["color"],
                })
                uid += 1
    return units


def _font(doc, page, u):
    """(1) the embedded font if it has every glyph, (2) a metric-compatible substitute, (3) a base-14 font of the same style."""
    name = u["font"]
    low = name.lower()
    try:
        for fnt in page.get_fonts():
            if fnt[3].split("+")[-1] == name.split("+")[-1]:
                buf = doc.extract_font(fnt[0])[3]
                if buf:
                    return {"fontname": f"emb{fnt[0]}", "fontbuffer": buf, "font": pymupdf.Font(fontbuffer=buf)}
    except Exception:  # noqa: BLE001 - fall through to the substitutes
        pass
    bold, italic = "bold" in low or "black" in low, "italic" in low or "oblique" in low
    for key, fam in SUBSTITUTES.items():
        f = FONTS_DIR / f"{fam}-{'Bold' if bold else ''}{'Italic' if italic else ''}{'Regular' if not (bold or italic) else ''}.ttf"
        if key in low and f.exists():
            return {"fontname": fam + str(bold) + str(italic), "fontfile": str(f), "font": pymupdf.Font(fontfile=str(f))}
    serif = any(k in low for k in ("times", "serif", "georgia", "garamond", "cambria", "roman"))
    n = (("tiro", "tibo", "tiit", "tibi") if serif else ("helv", "hebo", "heit", "hebi"))[bold + 2 * italic]
    return {"fontname": n, "font": pymupdf.Font(n)}


def apply(src: Path, plan: dict, dst: Path, tailoring: str = "light") -> dict:
    """Returns {"overflow": [uid...], "edited": [{uid, page, bbox}]}. The caller runs verify."""
    units = outline(src, tailoring)
    check_plan(units, plan, tailoring)
    if plan.get("reorder"):
        raise DocError("reorder_unsupported", "reordering is only supported for DOCX resumes; use edits only")  # shortcut: PDF reorder needs layout moves, upgrade if a PDF user needs it
    by = {u["uid"]: u for u in units}
    overflow, edited = [], []
    right: dict[int, float] = {}
    for u in units:
        right[u["page"]] = max(right.get(u["page"], 0), u["bbox"][2])
    with pymupdf.open(src) as doc:
        todo = [(by[e["uid"]], e["new_text"]) for e in plan.get("edits") or []]
        for u, _ in todo:
            doc[u["page"]].add_redact_annot(pymupdf.Rect(u["bbox"]))
        for page in doc:
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
        for u, new in todo:
            page = doc[u["page"]]
            f = _font(doc, page, u)
            text = u["prefix"] + new
            if not all(f["font"].has_glyph(ord(c)) for c in text if not c.isspace()):
                f = {"fontname": "helv", "font": pymupdf.Font("helv")}  # last resort: base-14 (Latin-1 only)
                text = text.encode("latin-1", "replace").decode("latin-1")
            kw = {k: f[k] for k in ("fontbuffer", "fontfile") if k in f}
            c = u["color"]
            # a block's box is exactly its text: draw into the full column width, with a little height slack
            rect = pymupdf.Rect(u["bbox"][0], u["bbox"][1], right[u["page"]], u["bbox"][3] + u["size"] * 0.3)
            left = page.insert_textbox(rect, text, fontsize=u["size"], fontname=f["fontname"], color=((c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255), **kw)
            if left < 0:
                overflow.append(u["uid"])
            edited.append({"uid": u["uid"], "page": u["page"], "bbox": list(rect)})
        doc.save(dst, garbage=3, deflate=True)
    return {"overflow": overflow, "edited": edited}
