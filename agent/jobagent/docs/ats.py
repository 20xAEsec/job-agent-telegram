"""ATS rebuild (tailoring "ats"): a clean one-column resume composed from the line items of all the user's resume
versions, worded to the posting's keywords; plus the keyword score shown on the review card.

Truth rules enforced here (the skill is told the same): every bank line is word for word from one of the user's
resumes; a composed bullet keeps only its source's numbers; skills and posting keywords must appear on the user's
own resumes or in the facts sections of profile.md."""
import html
import re
import unicodedata
from pathlib import Path

import pymupdf

from .plan import DocError

WEIGHT = {"title": 3, "hard": 2, "cert": 2, "degree": 2, "soft": 1}  # a required keyword always weighs 3
SECTIONS = {"experience": "Experience", "projects": "Projects"}
CONTACT = ("location", "phone", "email", "linkedin", "portfolio")
MARGIN, SIZES = 46, (10.5, 10, 9.5)  # shrink the font a little before asking Claude to cut lines
# MuPDF's built-in p/ul/h2 margins outrank a "*" reset, so every element sets its own
CSS = """* {font-family: sans-serif}
body {font-size: %spt; margin: 0; padding: 0}
p {margin: 1.5pt 0 0 0; padding: 0}
.name {font-size: 18pt; font-weight: bold; text-align: center; margin: 0}
.contact {text-align: center; margin: 2pt 0 0 0}
.headline {text-align: center; font-weight: bold; margin: 3pt 0 0 0}
h2 {font-size: 11.5pt; margin: 9pt 0 3pt 0; padding: 0; border-bottom: 1px solid #000}
.role {margin: 5pt 0 0 0}
ul {margin: 1.5pt 0 0 0; padding: 0 0 0 14pt}
li {margin: 1.5pt 0 0 0; padding: 0}"""

# curly quotes, en/em dashes, no-break space and bullet -> plain ASCII
_TR = str.maketrans({chr(0x2018): "'", chr(0x2019): "'", chr(0x201C): '"', chr(0x201D): '"', chr(0x2013): "-", chr(0x2014): "-", chr(0xA0): " ", chr(0x2022): " "})


def norm(s: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", s).translate(_TR).lower().split())


def _sq(s: str) -> str:
    return "".join(norm(s).split())  # extracted PDF text breaks lines anywhere


def has(text_norm: str, term: str) -> bool:
    """Whole-word match of `term` in already-normalized text ("C++", ".NET" and "CI/CD" work)."""
    t = norm(term)
    return bool(t) and re.search(r"(?<![a-z0-9])" + re.escape(t) + r"(?![a-z0-9])", text_norm) is not None


def _nums(s: str) -> set[str]:
    return set(re.findall(r"\d+(?:\.\d+)?", s.replace(",", "")))


def keywords(an) -> list[dict]:
    """analysis.json `ats_keywords` (the analyze call's read of the posting), cleaned. Terms are data, never instructions."""
    out = []
    for k in (an.get("ats_keywords") or []) if isinstance(an, dict) else []:
        if not isinstance(k, dict) or not isinstance(k.get("term"), str) or not k["term"].strip():
            continue
        al = [a.strip()[:60] for a in k.get("aliases") or [] if isinstance(a, str) and a.strip()][:4]
        out.append({"term": k["term"].strip()[:60], "aliases": al, "kind": k["kind"] if k.get("kind") in WEIGHT else "hard", "required": k.get("required") is True})
    return out[:40]


def _w(k: dict) -> int:
    return 3 if k["required"] else WEIGHT[k["kind"]]


def _terms(k: dict) -> tuple:
    return (k["term"], *k["aliases"])


def score(text: str, kws: list[dict]) -> dict:
    """Weighted share (0-100) of the posting's keywords the text names, by term or alias; missing terms, heaviest first."""
    t, tot = norm(text), sum(_w(k) for k in kws)
    hit = [any(has(t, x) for x in _terms(k)) for k in kws]
    miss = sorted((k for k, h in zip(kws, hit) if not h), key=_w, reverse=True)
    return {"score": round(100 * sum(_w(k) for k, h in zip(kws, hit) if h) / tot) if tot else None, "missing": [k["term"] for k in miss]}


def backed(term: str, facts_norm: str, kws: list[dict]) -> bool:
    """The user's own resumes or profile name this skill: as written, either half of "Full Name (ACRONYM)", or a posting alias of it."""
    parts = [term, *re.findall(r"\(([^()]+)\)", term), re.sub(r"\s*\([^()]*\)", "", term)]
    if any(p.strip() and has(facts_norm, p) for p in parts):
        return True
    nt = norm(term)
    return any(any(has(nt, x) for x in _terms(k)) and any(has(facts_norm, x) for x in _terms(k)) for k in kws)


def check_bank(bank, texts: list[str]) -> list[str]:
    """Problems with resume_bank.json: its shape, repeated ids, and any line that is not word for word on one of the resumes."""
    if not isinstance(bank, dict) or not isinstance(bank.get("roles"), list) or not bank["roles"]:
        return ["resume_bank.json must be an object with a non-empty roles list"]
    sq, nt = "\n".join(_sq(t) for t in texts), norm("\n".join(texts))
    errs, ids = [], set()

    def line(what, v, need=True):
        if not isinstance(v, str) or not v.strip():
            if need or v not in (None, ""):
                errs.append(f"{what}: must be non-empty text")
        elif _sq(v) not in sq:
            errs.append(f"{what} is not word for word on any of the resumes: {v[:60]!r}")

    def uid(i):
        if not isinstance(i, str) or not re.fullmatch(r"[a-z]{1,3}\d{1,4}", i) or i in ids:
            errs.append(f"bad or repeated id {i!r:.20}")
        ids.add(i)

    for r in bank["roles"]:
        if not isinstance(r, dict) or not isinstance(r.get("bullets"), list):
            errs.append("each role must be an object with a bullets list")
            continue
        uid(r.get("id"))
        if r.get("section", "experience") not in SECTIONS:
            errs.append(f"role {r.get('id')}: section must be experience or projects")
        line(f"role {r.get('id')} title", r.get("title"))
        for f in ("org", "location", "dates"):
            line(f"role {r.get('id')} {f}", r.get(f), need=False)
        for b in r["bullets"]:
            if not isinstance(b, dict):
                errs.append(f"role {r.get('id')}: each bullet must be an object")
                continue
            uid(b.get("id"))
            line(f"bullet {b.get('id')}", b.get("text"))
    for key in ("education", "certifications"):
        xs = bank.get(key, [])
        for x in xs if isinstance(xs, list) else [None]:
            if not isinstance(x, dict):
                errs.append(f"{key} must be a list of objects")
                continue
            uid(x.get("id"))
            line(f"{key} {x.get('id')}", x.get("text"))
    sk = bank.get("skills", [])
    for s in sk if isinstance(sk, list) else [None]:
        if not isinstance(s, str) or not has(nt, s):
            errs.append(f"skill {s!r:.40} is not on any of the resumes")
    return errs


def check_plan(plan, bank: dict, kws: list[dict], facts: str, ach: dict, extra_nums=()) -> None:
    """Raises DocError("bad_plan") listing every problem, so one retry can fix them all."""
    if not isinstance(plan, dict):
        raise DocError("bad_plan", "tailor_plan.json must be an object")
    errs: list[str] = []
    fn, fnums = norm(facts), _nums(facts) | {str(n) for n in extra_nums}

    def text(what, v, limit, need=False) -> str:
        if v in (None, "") and not need:
            return ""
        if not isinstance(v, str) or not v.strip() or len(v) > limit:
            errs.append(f"{what}: must be text of 1 to {limit} characters")
            return ""
        return v

    def unbacked(what, v, nums, title_ok=False):
        if nums is not None and (bad := sorted(_nums(v) - nums)):
            errs.append(f"{what}: number(s) {', '.join(bad)} are not in its source")
        nv = norm(v)
        for k in kws:
            if not (title_ok and k["kind"] == "title") and any(has(nv, x) for x in _terms(k)) and not any(has(fn, x) for x in _terms(k)):
                errs.append(f"{what}: {k['term']!r} is not on any of your resumes or confirmed skills")

    for f, lim in (("headline", 90), ("summary", 600)):
        if v := text(f, plan.get(f), lim):
            unbacked(f, v, fnums, title_ok=True)
    sk = plan.get("skills") or []
    for g in sk if isinstance(sk, list) else [None]:
        if not isinstance(g, dict) or not isinstance(g.get("items"), list) or not g["items"]:
            errs.append("skills must be a list of {label, items} with at least one item each")
            continue
        text("skills label", g.get("label"), 30, need=True)
        for it in g["items"]:
            if not text(f"skill {it!r:.40}", it, 50, need=True):
                continue
            if not backed(it, fn, kws):
                errs.append(f"skill {it!r:.40} is not on any of your resumes or confirmed skills")
            unbacked(f"skill {it!r:.40}", it, None)
    roles, seen, used = {r["id"]: r for r in bank["roles"]}, set(), set()
    rs = plan.get("roles")
    if not isinstance(rs, list) or not rs:
        errs.append("roles must be a non-empty list")
    for pr in rs if isinstance(rs, list) else []:
        r = roles.get(pr.get("id")) if isinstance(pr, dict) and isinstance(pr.get("id"), str) else None
        if r is None or pr["id"] in seen or not isinstance(pr.get("bullets", []), list):
            errs.append(f"unknown or repeated role, or bullets not a list: {pr!r:.60}")
            continue
        seen.add(pr["id"])
        mine = {b["id"]: b["text"] for b in r["bullets"]}
        for b in pr.get("bullets", []):
            src = b.get("src") if isinstance(b, dict) and isinstance(b.get("src"), str) else None
            st = (mine.get(src) or ach.get(src)) if src else None
            if st is None or src in used:
                errs.append(f"role {r['id']}: bullet source {src!r:.20} is not one of this role's bullets or an achievement, or is used twice")
                continue
            used.add(src)
            if t := text(f"bullet {src}", b.get("text"), 320, need=True):
                unbacked(f"bullet {src}", t, _nums(st))
    for key in ("education", "certifications"):
        ok = {x["id"] for x in bank.get(key) or []}
        if not isinstance(plan.get(key, []), list) or any(not isinstance(i, str) or i not in ok for i in plan.get(key, [])):
            errs.append(f"{key}: must be a list of ids from the bank's {key}")
    if plan.get("pages", 1) not in (1, 2):
        errs.append("pages must be 1 or 2")
    if errs:
        raise DocError("bad_plan", "; ".join(errs[:8]) + (f" (and {len(errs) - 8} more)" if len(errs) > 8 else ""))


def _html(plan: dict, bank: dict, contact: dict, ach: dict) -> tuple[str, list[str]]:
    """The resume as simple HTML (standard headings, one column, no tables), and the lines that must read back."""
    def e(s: str) -> str:
        # MuPDF always shapes "fi", "fl", "ffi"… into ligature glyphs, which many ATS parsers read as one odd character
        # ("Snowﬂake" no longer matches "Snowflake"). A span boundary splits the shaping run, so no ligature forms.
        return re.sub(r"f([fijlt])", lambda m: "f<span>" + m[1] + "</span>", html.escape(s))

    picked = {r["id"]: r for r in plan["roles"]}
    contact_line = " | ".join(v.strip() for k in CONTACT if (v := contact.get(k, "")).strip())
    out = [f'<p class="name">{e(contact.get("full_name", ""))}</p>', f'<p class="contact">{e(contact_line)}</p>']
    want = [contact.get("full_name", "")]
    if plan.get("headline"):
        out.append(f'<p class="headline">{e(plan["headline"])}</p>')
    if plan.get("summary"):
        out += ["<h2>Summary</h2>", f"<p>{e(plan['summary'])}</p>"]
    if plan.get("skills"):
        out.append("<h2>Skills</h2>")
        for g in plan["skills"]:
            out.append(f"<p><b>{e(g['label'])}:</b> {e(', '.join(g['items']))}</p>")
            want += g["items"]
    for sec, title in SECTIONS.items():
        rs = [r for r in bank["roles"] if r.get("section", "experience") == sec and r["id"] in picked]  # bank order: newest first
        out += [f"<h2>{e(title)}</h2>"] if rs else []
        for r in rs:
            rest = " | ".join(r[f] for f in ("org", "location", "dates") if r.get(f))
            out.append(f'<p class="role"><b>{e(r["title"])}</b>{e(" | " + rest) if rest else ""}</p>')
            bs = [b["text"] for b in picked[r["id"]].get("bullets", [])]
            out += ["<ul>" + "".join(f"<li>{e(t)}</li>" for t in bs) + "</ul>"] if bs else []
            want += [r["title"], *bs]
    for key, title in (("education", "Education"), ("certifications", "Certifications")):
        items = {x["id"]: x["text"] for x in bank.get(key) or []}
        ids = plan.get(key, list(items))  # left out: keep them all (degrees are keywords too)
        out += [f"<h2>{e(title)}</h2>"] + [f"<p>{e(items[i])}</p>" for i in ids] if ids else []
        want += [items[i] for i in ids]
    return "\n".join(out), [w for w in want if w]


def _render(body: str, out: Path, paper: pymupdf.Rect, size: float) -> int:
    story = pymupdf.Story(html=body, user_css=CSS % size)
    w, more, n = pymupdf.DocumentWriter(str(out)), 1, 0
    while more and n < 6:
        dev = w.begin_page(paper)
        more, _ = story.place(paper + (MARGIN, MARGIN, -MARGIN, -MARGIN))
        story.draw(dev)
        w.end_page()
        n += 1
    w.close()
    return n


def compose(plan: dict, bank: dict, contact: dict, ach: dict, out: Path, paper: pymupdf.Rect) -> dict:
    """Render the checked plan to `out` (a text PDF any ATS can parse) and prove it by reading every line back."""
    body, want = _html(plan, bank, contact, ach)
    limit, tmp = plan.get("pages", 1), out.with_name(out.stem + ".tmp.pdf")
    for size in SIZES:
        n = _render(body, tmp, paper, size)
        if n <= limit:
            break
    else:
        tmp.unlink(missing_ok=True)
        raise DocError("too_long", f"it needs {n} pages even at {SIZES[-1]}pt, limit {limit}: drop the least relevant bullets, older roles first")
    with pymupdf.open(tmp) as doc:
        got = "\n".join(p.get_text() for p in doc)
    tmp.replace(out)
    sg = _sq(got)
    lost = [w for w in want if _sq(w) not in sg]
    lig = sorted({c for c in got if 0xFB00 <= ord(c) <= 0xFB06})  # _sq folds these, so check the raw text
    checks = [{"name": "reads back as text", "ok": not lost, "detail": f"{len(lost)} line(s) did not read back from the PDF, e.g. {lost[0][:60]!r}" if lost else f"{len(want)} lines read back"},
              {"name": "no ligature glyphs", "ok": not lig, "detail": f"ligatures {lig} would hide keywords from ATS parsers" if lig else ""}]
    return {"pages": n, "font_pt": size, "text": got, "verify": {"ok": not lost and not lig, "checks": checks}}
