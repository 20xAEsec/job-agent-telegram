"""Tool-less Claude calls (the v4 engine). `llm input <name>` writes what one judgment needs to data/run/llm/<name>-<job>.in.json;
the app pipes that file into `claude -p` with no tools, no MCP and a JSON schema, then `llm accept <name> --file <answer>` checks
the answer (v3 rule 10) and only then writes the job's file. Third-party text (postings, form labels, resume text, typed change
requests) is wrapped with safety.untrusted: it is data, never instructions. Claude never runs a command."""
import json
import re
from pathlib import Path

from . import feedback, profile, resume, safety, store, tailor
from .ats.base import match_option
from .docs import ats
from .docs.plan import LIMIT, DocError
from .docs.plan import check_plan as check_edits
from .paths import atomic_write_json, atomic_write_text

CAP = 24_000  # posting characters sent to Claude (fetch keeps 30,000)
NAMES = ("analyze", "tailor_ats", "tailor_edit", "cover_letter", "kit", "revise", "resume_profile", "resume_bank", "followup", "screen")
CLASSES = ("profile", "generated", "document", "must_ask")
KINDS = ("choice", "multi", "yesno", "text", "number", "date")
KEY = re.compile(r"^[a-z0-9_]{1,40}$")
QID = re.compile(r"^[A-Za-z0-9_]{1,16}$")
# v3 rule 4: never guessed. A code backstop for the analysis's own `sensitive` flag.
SENSITIVE = re.compile(r"authori[sz]|sponsor|\bvisa\b|salary|compensation|pay (?:range|expectation)|(?:expected|desired) pay|gender|\bsex\b|pronoun|\brace\b|ethnic|"
                       r"hispanic|latin[oax]|veteran|disabilit|criminal|convict|felony|date of birth|birth ?date|\bage\b|years old|18 years|relocat|clearance|"
                       r"non-?compete|non-?solicit|attest|certify|\breferences?\b", re.I)
EMAIL_ASK = re.compile(r"e-?mail", re.I)
PHONE_ASK = re.compile(r"phone|mobile|cell|telephone|\btel\b|contact number", re.I)
DECLINE = re.compile(r"decline|prefer not|not to (?:say|answer|disclose|self)|(?:don.?t|do not) (?:wish|want) to", re.I)
NO = re.compile(r"^\s*no\b|\bnot\b|\bdon.?t\b|\bdo not\b|\bnever\b|\bwill not\b|\bwon.?t\b", re.I)
YES = re.compile(r"^\s*yes\b|\bi am\b|\bi have\b|\bi will\b|\bi can\b|^\s*true\b", re.I)


class Rejected(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


# ---- shared readers ----

def _load(p: Path, default=None):
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def _settings(d: Path) -> dict:
    return _load(d / "settings.json", {}) or {}


def _sections(d: Path) -> dict:
    return profile.show(d)["sections"] if (d / "profile.md").exists() else {}


def _facts(d: Path, contact=True) -> dict:
    s = _sections(d)
    return {k: s[k].strip() for k in (*tailor.FACT_SECTIONS, *(["Contact"] if contact else [])) if s.get(k, "").strip()}


def _contact(d: Path) -> dict:
    return profile._fields(_sections(d).get("Contact", "").splitlines())


def _saved(d: Path, job: str | None = None) -> list[dict]:
    return [{k: a[k] for k in ("key", "base_key", "question", "answer", "sensitive", "scope")} for a in profile.answer_list(d, job)["answers"]]


def _fields(d: Path, job: str) -> list[dict] | None:
    """fields.json for a fillable form, or None (no adapter, or the form could not be read)."""
    if store.meta(d, job).get("ats", "generic") == "generic":
        return None
    f = _load(store.jdir(d, job) / "fields.json")
    return f if isinstance(f, list) else None


def _analysis(d: Path, job: str) -> dict:
    a = _load(store.jdir(d, job) / "analysis.json", {})
    return a if isinstance(a, dict) else {}


def _wrap(source: str, obj) -> str:
    return safety.untrusted(source, obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=1))


def _s(v, n: int) -> str:
    return " ".join(str(v if v is not None else "").split())[:n]


def is_sensitive(f: dict, flagged=False) -> bool:
    return bool(flagged) or f.get("section") in ("compliance", "demographic") or bool(SENSITIVE.search(f.get("label", "")))


def _pol(v) -> str | None:
    t = str(v)
    return "decline" if DECLINE.search(t) else "no" if NO.search(t) else "yes" if YES.search(t) else None


def same_answer(saved, value) -> bool:
    """Code's check that a form value carries a saved private answer: equal, one contains the other, or the same
    yes / no / decline. Whether the meaning really matches stays the analysis's job; this only stops a guessed value."""
    a, b = _s(saved, 300).casefold(), _s(value, 300).casefold()
    if not a or not b:
        return False
    return a == b or a in b or b in a or (_pol(a) is not None and _pol(a) == _pol(b))


def _leaks(fid: str, label: str, value, contact: dict) -> list[str]:
    """Profile data only goes into a field that asks for it (v3 rule 10)."""
    v, out = str(value or ""), []
    email, phone = (contact.get("email") or "").strip().lower(), re.sub(r"\D", "", contact.get("phone") or "")
    if email and email in v.lower() and not EMAIL_ASK.search(label):
        out.append(f"{fid}: the user's email goes only into a field that asks for an email")
    if len(phone) >= 7 and phone in re.sub(r"\D", "", v) and not PHONE_ASK.search(label):
        out.append(f"{fid}: the user's phone number goes only into a field that asks for a phone number")
    return out


def _value(fid: str, f: dict, v, contact: dict) -> tuple[object, list[str]]:
    """A value checked against its field (an option for selects, true/false for a checkbox); the page's own option spelling."""
    t = f.get("type")
    if t == "file":
        return v, [f"{fid}: a file upload is class document"]
    if t == "checkbox":
        return (v, []) if isinstance(v, bool) else (v, [f"{fid}: a checkbox value must be true or false"])
    if t in ("select", "multiselect") and f.get("options"):
        vs = v if isinstance(v, list) else [v]
        got = [match_option(f["options"], x) for x in vs]
        if not vs or None in got:
            return v, [f"{fid}: the value must be one of the field's options: {', '.join(f['options'][:12])}"]
        return (got if t == "multiselect" else got[0]), []
    if not isinstance(v, (str, int, float)) or not str(v).strip() or len(str(v)) > 2000:
        return v, [f"{fid}: the value must be text of 1 to 2000 characters"]
    return str(v), _leaks(fid, f.get("label", ""), v, contact)


def _key_for(label: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", label.lower())).strip("_")[:40] or "answer"


def question_for(f: dict, q: dict | None, sens: bool, save_key: str | None) -> dict:
    """The question the user answers for one field. Options always come from the form itself, never from Claude."""
    t, q = f.get("type"), q or {}
    kind = {"select": "choice", "multiselect": "multi", "checkbox": "yesno"}.get(t) or (q.get("kind") if q.get("kind") in ("text", "number", "date") else "text")
    opts = f.get("options") or []
    if kind in ("choice", "multi") and len(opts) < 2:
        kind = "text"
    key = save_key if isinstance(save_key, str) and KEY.match(save_key) else _key_for(f.get("label", ""))
    text = _s(q.get("text") or f.get("label") or f["fid"], 500)
    return {"fid": f["fid"], "text": text, "kind": kind, **({"options": opts[:40]} if kind in ("choice", "multi") else {}),
            "sensitive": sens, "save_key": key, "default_save": "global", "why": _s(q.get("why") or "Required on this application", 300)}


# ---- inputs ----

def _in_analyze(d: Path, job: str, extra: dict) -> dict:
    j, s = store.jdir(d, job), _settings(d)
    try:
        posting = (j / "posting.md").read_text("utf-8")
    except OSError as e:
        raise store.JobError("missing_file", "posting.md is missing: fetch the posting first") from e
    if len(posting) > CAP:
        posting = posting[:CAP] + "\n[cut here]\n</untrusted_content>\n"
    fields = _fields(d, job)
    f, a = s.get("filters") or {}, s.get("apply") or {}
    keep = ("titles", "related_titles", "experience_level", "years_experience", "locations", "country", "remote", "min_salary", "currency",
            "allow_unknown_salary", "job_types", "exclude_keywords")
    return {"posting": posting, "supported": fields is not None,
            "form_fields": _wrap("application form", [{k: x.get(k) for k in ("fid", "label", "type", "required", "options", "section")} for x in fields]) if fields is not None else None,
            "profile": _facts(d), "saved_answers": _saved(d, job),
            "settings": {**{k: f.get(k) for k in keep}, "draft_free_text": a.get("draft_free_text", True)},
            "feedback": feedback.summary(d), "tier": extra.get("tier") or "exact"}


def _bank_facts(d: Path) -> dict:
    secs = _sections(d)
    ach = {k: v for k, v in profile._fields(secs.get("Achievements", "").splitlines()).items() if re.fullmatch(r"a\d{1,2}", k) and v.strip()}
    return {"confirmed_skills": secs.get("Confirmed skills", "").strip(), "achievements": ach}


def _in_tailor_ats(d: Path, job: str, extra: dict) -> dict:
    an, years = _analysis(d, job), (_settings(d).get("filters") or {}).get("years_experience")
    bank = _load(d / "resume_bank.json")
    if not isinstance(bank, dict):
        raise DocError("no_bank", "resume_bank.json is missing: run the resume_bank call first")
    return {"bank": bank, **_bank_facts(d), "years_experience": years, "role": an.get("role"), "company": an.get("company"),
            "ats_keywords": ats.keywords(an), "match": an.get("match") or {}, "main_resume_pages": _pages(d),
            **_retry(store.jdir(d, job) / "tailor_plan.json", extra)}


def _pages(d: Path) -> int | None:
    for p in (d / "base_resume.pdf", d / "tmp" / "base_render.pdf"):
        if p.exists():
            import pymupdf

            with pymupdf.open(p) as x:
                return x.page_count
    return None


def _retry(plan_file: Path, extra: dict) -> dict:
    """On a second try: the previous plan and what was wrong with it (from `tailor` or an accept check)."""
    errs = [_s(e, 300) for e in extra.get("errors") or []][:12]
    return {"previous_plan": _load(plan_file), "errors": errs} if errs else {}


def _in_tailor_edit(d: Path, job: str, extra: dict) -> dict:
    o, an = tailor.outline(d), _analysis(d, job)
    others = [s for s in resume.sources(d) if s["name"] != "main"]
    return {"tailoring": o["tailoring"], "max_edits": LIMIT.get(o["tailoring"], 5), "units": o.get("units", []), **_bank_facts(d),
            "other_versions": [_wrap(f"resume version {s['name']}", Path(s["text_file"]).read_text("utf-8")) for s in others],
            "ats_keywords": ats.keywords(an), "must_haves": (an.get("match") or {}).get("must_haves") or [], "role": an.get("role"),
            **_retry(store.jdir(d, job) / "tailor_plan.json", extra)}


def _in_cover_letter(d: Path, job: str, extra: dict) -> dict:
    an = _analysis(d, job)
    m = an.get("match") or {}
    return {"company": an.get("company"), "role": an.get("role"), "reasons": m.get("reasons") or [], "must_haves": m.get("must_haves") or [],
            "profile": _facts(d, contact=False), **({"errors": extra["errors"]} if extra.get("errors") else {})}


def _in_kit(d: Path, job: str, extra: dict) -> dict:
    an = _analysis(d, job)
    return {"company": an.get("company"), "role": an.get("role"), "reasons": (an.get("match") or {}).get("reasons") or [],
            "posting_questions": an.get("posting_questions") or [], "profile": _facts(d), "saved_answers": _saved(d, job),
            "draft_free_text": (_settings(d).get("apply") or {}).get("draft_free_text", True)}


def _in_revise(d: Path, job: str, extra: dict) -> dict:
    j, an = store.jdir(d, job), _analysis(d, job)
    plan, fields = _load(j / "plan.json", {}) or {}, {f["fid"]: f for f in _fields(d, job) or []}
    cls = {c.get("fid"): c for c in an.get("field_classification") or [] if isinstance(c, dict)}
    rows = []
    for r in plan.get("fields") or []:
        f = fields.get(r.get("fid"))
        if not f or r.get("action") in ("skip", "upload"):
            continue
        sens = is_sensitive(f, cls.get(f["fid"], {}).get("sensitive"))
        rows.append({"fid": f["fid"], "label": _s(f["label"], 200), "type": f["type"], "options": f.get("options") or [], "sensitive": sens,
                     **({} if sens else {"value": r.get("value")})})  # private answers never go to Claude
    letter = (j / "cover_letter.md").read_text("utf-8") if (j / "cover_letter.md").exists() else None
    mode = tailor._tailoring(d)
    return {"request": _wrap("the user's change request", str(extra.get("request") or "")[:2000]), "answers": rows, "tailoring": mode,
            "tailor_plan": _load(j / "tailor_plan.json"), "cover_letter_md": letter,
            **({"bank": _load(d / "resume_bank.json"), **_bank_facts(d), "ats_keywords": ats.keywords(an)} if mode == "ats"
               else {"units": tailor.outline(d).get("units", [])})}


def _in_resume_profile(d: Path, job, extra: dict) -> dict:
    try:
        text = (d / "resume_text.txt").read_text("utf-8")
    except OSError as e:
        raise resume.ResumeError("no_resume", "no resume imported yet") from e
    return {"resume_text": _wrap("the user's resume", text[:CAP])}


def _in_resume_bank(d: Path, job, extra: dict) -> dict:
    return {"resumes": [{"name": s["name"], "text": _wrap(f"resume {s['name']}", Path(s["text_file"]).read_text("utf-8")[:CAP])} for s in resume.sources(d)],
            **({"errors": extra["errors"], "previous_bank": _load(d / "resume_bank.json")} if extra.get("errors") else {})}


def _in_followup(d: Path, job: str, extra: dict) -> dict:
    an, st = _analysis(d, job), store.status(d, job)
    sent = next((h["at"][:10] for h in reversed(st["history"]) if h["status"] in ("SUBMITTED", "APPLIED_SELF")), "")
    return {"company": an.get("company"), "role": an.get("role"), "reasons": (an.get("match") or {}).get("reasons") or [],
            "applied_on": sent, "name": _contact(d).get("full_name", "")}


# ---- accept: check, then write ----

def _acc_analyze(d: Path, job: str, ans: dict, extra: dict) -> dict:
    j, s = store.jdir(d, job), _settings(d)
    draft = (s.get("apply") or {}).get("draft_free_text", True)
    fl = _fields(d, job)
    fields = {f["fid"]: f for f in fl or []}
    saved = {}
    for a in _saved(d, job):
        saved.setdefault(a["base_key"], a)
        saved[a["key"]] = a
    contact, errs = _contact(d), []
    m = ans.get("match") if isinstance(ans.get("match"), dict) else {}
    if not isinstance(m.get("score"), int) or not 0 <= m["score"] <= 100:
        errs.append("match.score must be an integer from 0 to 100")
    for k in ("company", "role"):
        if not _s(ans.get(k), 200):
            errs.append(f"{k} is missing")
    cls, asked = [], {}
    for q in ans.get("questions") or []:
        if isinstance(q, dict) and q.get("fid") in fields:
            asked[q["fid"]] = q
    for c in ans.get("field_classification") or []:
        if not isinstance(c, dict) or c.get("fid") not in fields:
            errs.append(f"field_classification: unknown fid {c.get('fid') if isinstance(c, dict) else c!r:.40}")
            continue
        fid, f = c["fid"], fields[c["fid"]]
        if c.get("class") not in CLASSES:
            errs.append(f"{fid}: class must be one of {', '.join(CLASSES)}")
            continue
        row = {"fid": fid, "class": c["class"], "value": c.get("value"), "save_key": c.get("save_key") if isinstance(c.get("save_key"), str) else None,
               "sensitive": is_sensitive(f, c.get("sensitive")), "unusual": bool(c.get("unusual")) or bool(safety.UNUSUAL.search(f.get("label", ""))),
               "reason": _s(c.get("reason"), 120)}
        if row["unusual"]:  # never auto-filled
            row.update({"class": "must_ask", "value": None})
        if f.get("type") == "file" and row["class"] in ("profile", "generated"):
            row["class"] = "document"
        if row["class"] == "generated" and (row["sensitive"] or not draft):
            row.update({"class": "must_ask", "value": None})  # a private question is never drafted; drafting may be off
        if row["class"] == "profile" and row["sensitive"]:
            a = saved.get(row["save_key"] or "")
            vs = row["value"] if isinstance(row["value"], list) else [row["value"]]
            if not a or not all(same_answer(a["answer"], v) for v in vs):
                row.update({"class": "must_ask", "value": None})  # not backed by a saved answer: ask the user once
        if row["class"] in ("profile", "generated"):
            row["value"], e = _value(fid, f, row["value"], contact)
            errs += e
        else:
            row["value"] = None
        cls.append(row)
    seen = {c["fid"] for c in cls}
    for fid, f in fields.items():  # a field the answer left out is the user's to answer
        if fid not in seen:
            cls.append({"fid": fid, "class": "document" if f.get("type") == "file" else "must_ask", "value": None, "save_key": None,
                        "sensitive": is_sensitive(f), "unusual": bool(safety.UNUSUAL.search(f.get("label", ""))), "reason": "not classified"})
    # Questions: only for required fields nobody can fill. Optional ones are left blank: fewer interruptions, nothing guessed.
    questions = []
    for c in cls:
        f = fields[c["fid"]]
        if c["class"] == "must_ask" and f.get("required") and not c["unusual"]:
            q = question_for(f, asked.get(c["fid"]), c["sensitive"], (asked.get(c["fid"]) or {}).get("save_key") or c["save_key"])
            questions.append({"qid": f"q{len(questions) + 1}", **q})
    if errs:
        raise Rejected(errs)
    cover = [f for f in fields.values() if re.search(r"cover.?letter", f"{f['fid']} {f.get('label', '')}", re.I) and f.get("type") in ("file", "textarea")]
    an = {
        "company": _s(ans.get("company"), 100), "role": _s(ans.get("role"), 120), "location": _s(ans.get("location"), 100), "salary": _s(ans.get("salary"), 60),
        "seniority": _s(ans.get("seniority"), 40), "supported": fl is not None,
        "has_cover_letter_field": bool(cover), "cover_letter_required": any(f.get("required") for f in cover) or (fl is None and ans.get("cover_letter_required") is True),
        "posting_questions": [_s(x, 200) for x in ans.get("posting_questions") or [] if _s(x, 200)][:5] if fl is None else [],
        "match": {"score": m["score"], "reasons": [_s(x, 160) for x in m.get("reasons") or []][:4], "dealbreakers": [_s(x, 160) for x in m.get("dealbreakers") or []][:4],
                  "breakdown": {k: max(0, min(100, int(v))) for k, v in (m.get("breakdown") or {}).items() if k in ("title", "seniority", "skills", "location", "pay") and isinstance(v, (int, float))},
                  "must_haves": [{"text": _s(x.get("text"), 60), "status": x["status"]} for x in m.get("must_haves") or []
                                 if isinstance(x, dict) and x.get("status") in ("met", "partial", "missing") and _s(x.get("text"), 60)][:8]},
        "ats_keywords": ats.keywords(ans), "field_classification": cls, "questions": questions,
        "skip_detail": _s(ans.get("skip_detail"), 120), "injection_suspected": ans.get("injection_suspected") is True,
    }
    atomic_write_json(j / "analysis.json", an)
    return {"score": m["score"], "supported": an["supported"], "questions": len(questions), "dealbreakers": an["match"]["dealbreakers"],
            "injection": an["injection_suspected"], "company": an["company"], "role": an["role"]}


def _truth(d: Path):
    """What a tailored resume may say: the resume texts, the checked bank, the facts text and the achievements."""
    texts = tailor._texts(d)
    bank = tailor._read_bank(d, texts)
    secs = _sections(d)
    return texts, bank, "\n".join([*texts.values(), *(secs.get(k, "") for k in tailor.FACT_SECTIONS)]), _bank_facts(d)["achievements"]


def _acc_tailor_ats(d: Path, job: str, ans: dict, extra: dict) -> dict:
    _, bank, facts, ach = _truth(d)
    years = (_settings(d).get("filters") or {}).get("years_experience")
    try:
        ats.check_plan(ans, bank, ats.keywords(_analysis(d, job)), facts, ach, [years] if isinstance(years, int) else [])
    except DocError as e:
        raise Rejected(str(e).split("; ")) from e
    atomic_write_json(store.jdir(d, job) / "tailor_plan.json", {k: ans[k] for k in ("pages", "headline", "summary", "skills", "roles", "education", "certifications") if k in ans})
    return {}


def _acc_tailor_edit(d: Path, job: str, ans: dict, extra: dict) -> dict:
    o = tailor.outline(d)
    plan = {"edits": ans.get("edits") or [], "reorder": ans.get("reorder") or []}
    try:
        check_edits(o.get("units", []), plan, o["tailoring"])
    except DocError as e:
        raise Rejected([str(e)]) from e
    atomic_write_json(store.jdir(d, job) / "tailor_plan.json", plan)
    return {}


def _letter(d: Path, body) -> str:
    if not isinstance(body, str) or not body.strip():
        raise Rejected(["body must be the letter text"])
    words = len(body.split())
    errs = [f"the letter is {words} words: at most {tailor.MAX_WORDS}"] if words > tailor.MAX_WORDS else []
    errs += _leaks("letter", "", body, _contact(d))  # the contact line is added by code
    if errs:
        raise Rejected(errs)
    return body.strip() + "\n"


def _acc_cover_letter(d: Path, job: str, ans: dict, extra: dict) -> dict:
    atomic_write_text(store.jdir(d, job) / "cover_letter.md", _letter(d, ans.get("body")))
    return {}


def _acc_kit(d: Path, job: str, ans: dict, extra: dict) -> dict:
    saved = {a["base_key"]: a for a in _saved(d, job)}
    contact, out, dropped = _contact(d), [], 0
    for x in ans.get("answers") or []:
        q, a = _s((x or {}).get("question"), 300), str((x or {}).get("answer") or "").strip()[:1200]
        if not q or not a:
            continue
        if SENSITIVE.search(q):  # only from a saved answer; otherwise the user answers it on the site
            s = saved.get(str(x.get("save_key") or ""))
            if not s or not same_answer(s["answer"], a):
                dropped += 1
                continue
        if _leaks("kit", q, a, contact):
            dropped += 1
            continue
        out.append({"question": q, "answer": a})
    atomic_write_json(store.jdir(d, job) / "kit.json", {"answers": out[:8]})
    return {"answers": len(out[:8]), "dropped": dropped}


def _acc_revise(d: Path, job: str, ans: dict, extra: dict) -> dict:
    action = ans.get("action")
    if action not in ("patch", "ask", "refuse"):
        raise Rejected(["action must be patch, ask or refuse"])
    reply = _s(ans.get("reply"), 300)
    if action != "patch":
        return {"action": action, "reply": reply, "changed": {}}
    j, an = store.jdir(d, job), _analysis(d, job)
    fields = {f["fid"]: f for f in _fields(d, job) or []}
    cls = {c.get("fid"): c for c in an.get("field_classification") or [] if isinstance(c, dict)}
    contact, errs, refused, vals = _contact(d), [], [], {}
    for x in ans.get("answers") or []:
        fid = (x or {}).get("fid")
        if fid not in fields:
            errs.append(f"answers: unknown fid {fid!r:.40}")
            continue
        if is_sensitive(fields[fid], cls.get(fid, {}).get("sensitive")):
            refused.append(fid)  # a private answer changes only with the user's own typed value (✏️ Edit an answer)
            continue
        vals[fid], e = _value(fid, fields[fid], x.get("value"), contact)
        errs += e
    tp, letter = ans.get("tailor_plan"), ans.get("cover_letter_md")
    if isinstance(tp, dict):
        try:
            (_acc_tailor_ats if tailor._tailoring(d) == "ats" else _acc_tailor_edit)(d, job, tp, {})
        except Rejected as e:
            errs += e.errors
    if isinstance(letter, str) and letter.strip():
        try:
            letter = _letter(d, letter)
        except Rejected as e:
            errs += e.errors
    if errs:
        raise Rejected(errs)
    if vals:
        atomic_write_json(j / "answers.json", {**(_load(j / "answers.json", {}) or {}), **vals})
    if isinstance(letter, str) and letter.strip():
        atomic_write_text(j / "cover_letter.md", letter)
    changed = {"answers": sorted(vals), "tailor": isinstance(tp, dict), "letter": isinstance(letter, str) and bool(letter.strip()),
               "original_resume": ans.get("use_original_resume") is True}
    return {"action": "patch", "reply": reply, "changed": changed, "refused": refused}


def _acc_resume_profile(d: Path, job, ans: dict, extra: dict) -> dict:
    if ans.get("not_a_resume") is True:
        return {"not_a_resume": True}
    c = ans.get("contact") if isinstance(ans.get("contact"), dict) else {}
    text = (d / "resume_text.txt").read_text("utf-8").lower()
    con = {k: _s(c.get(k), 200) for k in profile.CONTACT_KEYS}
    for k in ("email", "phone", "linkedin", "portfolio"):  # contact details are copied, never made up
        if con[k] and re.sub(r"\W", "", con[k].lower()) not in re.sub(r"\W", "", text):
            con[k] = ""
    lines = lambda xs: "\n".join(f"- {_s(x, 400)}" for x in (xs if isinstance(xs, list) else []) if _s(x, 400))  # noqa: E731
    sk = ans.get("skills") if isinstance(ans.get("skills"), dict) else {}
    draft = "\n".join(["# Profile", "## Contact", *(f"- {k}: {v}" for k, v in con.items()), "## Summary", _s(ans.get("summary"), 800),
                       "## Experience", lines(ans.get("experience")), "## Skills", f"- languages: {_s(sk.get('languages'), 400)}",
                       f"- tools: {_s(sk.get('tools'), 400)}", "## Education", lines(ans.get("education")), ""])
    tmp = d / "tmp" / "profile_draft.md"
    atomic_write_text(tmp, draft)
    profile.write_draft(d, tmp)
    card = ans.get("card") if isinstance(ans.get("card"), dict) else {}
    return {"summary": {**card, "email": con["email"], "phone": con["phone"]}}


def _acc_resume_bank(d: Path, job, ans: dict, extra: dict) -> dict:
    texts = tailor._texts(d)
    if errs := ats.check_bank(ans, list(texts.values())):
        raise Rejected(errs[:12])
    atomic_write_json(d / "resume_bank.json", {k: ans[k] for k in ("roles", "skills", "education", "certifications") if k in ans})
    return {"roles": len(ans["roles"]), "bullets": sum(len(r["bullets"]) for r in ans["roles"])}


def _acc_followup(d: Path, job: str, ans: dict, extra: dict) -> dict:
    subj, body = _s(ans.get("subject"), 120), str(ans.get("body") or "").strip()
    errs = [] if subj else ["subject is missing"]
    if not body or len(body.split()) > 120:
        errs.append("body must be 1 to 120 words")
    if errs:
        raise Rejected(errs)
    atomic_write_json(store.jdir(d, job) / "followup.json", {"subject": subj, "body": body})
    return {"subject": subj, "body": body}


INPUTS = {"analyze": _in_analyze, "tailor_ats": _in_tailor_ats, "tailor_edit": _in_tailor_edit, "cover_letter": _in_cover_letter, "kit": _in_kit,
          "revise": _in_revise, "resume_profile": _in_resume_profile, "resume_bank": _in_resume_bank, "followup": _in_followup}
ACCEPTS = {"analyze": _acc_analyze, "tailor_ats": _acc_tailor_ats, "tailor_edit": _acc_tailor_edit, "cover_letter": _acc_cover_letter, "kit": _acc_kit,
           "revise": _acc_revise, "resume_profile": _acc_resume_profile, "resume_bank": _acc_resume_bank, "followup": _acc_followup}
JOBLESS = {"resume_profile", "resume_bank", "screen"}


def _job(d: Path, name: str, job: str | None) -> str | None:
    if name not in INPUTS:
        raise store.JobError("bad_name", f"unknown call {name!r:.30}")
    if name in JOBLESS:
        return None
    store.status(d, job or "")  # unknown job: refuse
    return job


def build_input(d: Path, name: str, job: str | None = None, extra: dict | None = None) -> dict:
    job = _job(d, name, job)
    out = d / "run" / "llm" / f"{name}-{job or 'x'}.in.json"
    atomic_write_json(out, INPUTS[name](d, job, extra or {}))
    return {"ok": True, "file": str(out.resolve())}


def accept(d: Path, name: str, job: str | None, file: str, extra: dict | None = None) -> dict:
    job = _job(d, name, job)
    ans = _load(Path(file))
    if not isinstance(ans, dict):
        return {"ok": False, "code": "rejected", "error": "the answer is not a JSON object", "errors": ["the answer must be a JSON object"]}
    try:
        return {"ok": True, **ACCEPTS[name](d, job, ans, extra or {})}
    except Rejected as e:
        return {"ok": False, "code": "rejected", "error": "; ".join(e.errors[:8]), "errors": e.errors[:12]}
