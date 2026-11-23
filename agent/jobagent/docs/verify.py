"""Checks that a tailored resume still looks like the base one (DESIGN 8.4)."""
from pathlib import Path

import pymupdf

from .plan import norm

DPI, PAD, MAX_DIFF = 100, 3, 0.005


def _find(page, text: str):
    """Rects of the first and last 25 characters of a paragraph on this page (one line each)."""
    t = norm(text)
    a, b = page.search_for(t[:25]), page.search_for(t[-25:])
    return (a[0], b[-1]) if a and b else None


def _masks(doc, edits, key) -> dict[int, list]:
    out: dict[int, list] = {}
    for e in edits:
        if e.get("bbox") is not None:
            out.setdefault(e["page"], []).append(pymupdf.Rect(e["bbox"]))
            continue
        for pno, page in enumerate(doc):
            hit = _find(page, e[key])
            if hit:  # full-width band over the paragraph: an edit that adds a line then shows up as a shifted layout
                out.setdefault(pno, []).append(pymupdf.Rect(0, hit[0].y0, page.rect.width, max(hit[1].y1, hit[0].y1)))
    return out


def _gray(page, rects) -> pymupdf.Pixmap:
    pm = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY)
    k = DPI / 72
    for r in rects:
        pm.set_rect(pymupdf.IRect(int((r.x0 - PAD) * k), int((r.y0 - PAD) * k), int((r.x1 + PAD) * k) + 1, int((r.y1 + PAD) * k) + 1), (255,))
    return pm


def _diff_ratio(a: pymupdf.Pixmap, b: pymupdf.Pixmap) -> float:
    if (a.width, a.height) != (b.width, b.height):
        return 1.0
    bad, w = 0, a.width
    sa, sb = a.samples, b.samples
    for y in range(a.height):
        ra, rb = sa[y * w:(y + 1) * w], sb[y * w:(y + 1) * w]
        if ra != rb:
            bad += sum(1 for x, z in zip(ra, rb) if abs(x - z) > 32)
    return bad / (a.width * a.height)


def verify(base: Path, out: Path, edits: list[dict], overflow=()) -> dict:
    """edits: [{old, new, page?, bbox?}]. Returns {"ok", "checks": [{name, ok, detail}]}."""
    checks = []

    def add(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    with pymupdf.open(base) as b, pymupdf.open(out) as o:
        add("page count", len(b) == len(o), f"{len(b)} -> {len(o)}")
        add("no overflow", not overflow, f"units {list(overflow)} do not fit their box: shorten them" if overflow else "")
        squash = lambda t: "".join(t.split())  # noqa: E731 - line breaks can split words at hyphens
        text = squash(" ".join(p.get_text() for p in o))
        missing = [i for i, e in enumerate(edits) if squash(e["new"]) not in text]
        add("edits present", not missing, f"edit #{missing[0] + 1} text not found in the output" if missing else "")
        if len(b) == len(o):
            w = [r for p in b for r in (pymupdf.Rect(x[:4]) for x in p.get_text("words"))]
            m = min([min(r.x0, r.y0, b[0].rect.width - r.x1) for r in w] or [0]) - 1 if w else 0
            bad = [i for i, p in enumerate(o) for x in p.get_text("words")
                   if x[0] < m or x[1] < m or x[2] > p.rect.width - m or x[3] > p.rect.height - m]
            add("inside margins", not bad, f"text beyond the page margin on page {bad[0] + 1}" if bad else "")
            mb, mo = _masks(b, edits, "old"), _masks(o, edits, "new")
            worst = max((_diff_ratio(_gray(b[i], mb.get(i, []) + mo.get(i, [])), _gray(o[i], mb.get(i, []) + mo.get(i, []))) for i in range(len(b))), default=0)
            add("layout unchanged", worst <= MAX_DIFF, f"{worst:.2%} of the page differs outside the edits (limit {MAX_DIFF:.1%}): an edit probably changed the line count" if worst > MAX_DIFF else f"{worst:.2%} differs")
    return {"ok": all(c["ok"] for c in checks), "checks": checks}
