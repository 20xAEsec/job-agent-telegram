"""Deterministic prefilter (DESIGN 4.9): `drop_reason` returns why a candidate fails settings.filters, or None to keep it."""
import re
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher

# Word-level equivalences, applied to both sides before comparing ("synonym-table hit" for `close`).
SYNONYMS = {
    "cyber security": "cybersecurity", "cyber": "cybersecurity", "infosec": "cybersecurity", "information security": "cybersecurity",
    "sde": "software engineer", "swe": "software engineer", "software developer": "software engineer", "developer": "engineer",
    "sre": "site reliability engineer", "ml": "machine learning", "ai": "artificial intelligence",
}
SENIORITY = {"senior", "sr", "staff", "principal", "lead", "junior", "jr", "associate", "intern", "entry", "level", "i", "ii", "iii", "iv"}
THRESHOLD = {"close": 80, "broad": 60}
# Title parts for `parse`: abbreviations spelled out, the kind of role a word names, words that say nothing about the work,
# and words that mark a different line of work (only when none of the user's own titles uses them).
ABBR = {"appsec": "application security", "secops": "security operations", "soc": "security operations", "devsecops": "devops security",
        "infosec": "information security", "cybersecurity": "security", "cyber": "security", "swe": "software engineer", "sde": "software engineer",
        "sre": "site reliability engineer", "ml": "machine learning", "eng": "engineer", "dev": "developer", "bi": "business intelligence"}
ROLE = {**dict.fromkeys(["engineer", "developer", "architect", "programmer", "tester", "analyst", "specialist", "researcher", "hunter", "scientist",
                         "designer", "consultant", "administrator", "technician", "writer", "editor"], "ic"),
        **dict.fromkeys(["clerk", "assistant", "representative", "receptionist", "operator", "coordinator", "agent"], "ops"),
        **dict.fromkeys(["manager", "director", "head", "vp", "supervisor", "chief", "president"], "mgr")}
FILLER = {"and", "or", "of", "the", "for", "a", "an", "to", "in", "at", "on", "with", "team", "group", "remote", "us", "usa", "uk", "emea", "apac",
          "global", "contract", "hybrid", "onsite", "full", "part", "time", "new", "grad"}
# Not "marketing" or "customer": "Marketing Analyst" and "Customer Data Engineer" are still analyst and engineer jobs.
NEG = {"sales", "account", "recruiter", "recruiting", "recruitment", "counsel", "attorney", "paralegal", "nurse", "driver", "teacher"}


def _words(title: str) -> list[str]:
    return re.sub(r"[^a-z0-9+#]+", " ", title.lower().replace("&", " and ")).split()


def _syn(title: str) -> str:
    t = " " + " ".join(_words(title)) + " "
    for k, v in SYNONYMS.items():
        t = t.replace(f" {k} ", f" {v} ")
    return t.strip()


def _strip(t: str) -> str:
    return " ".join(w for w in t.split() if w not in SENIORITY)


def token_set_ratio(a: str, b: str) -> int:
    """fuzzywuzzy-style: a title whose words are a subset of the other's scores 100; otherwise the best partial overlap."""
    sa, sb = set(a.split()), set(b.split())
    common = " ".join(sorted(sa & sb))
    t1, t2 = (common + " " + " ".join(sorted(sa - sb))).strip(), (common + " " + " ".join(sorted(sb - sa))).strip()
    r = SequenceMatcher
    if not common:
        return round(100 * r(None, t1, t2).ratio())
    return round(100 * max(r(None, common, t1).ratio(), r(None, common, t2).ratio(), r(None, t1, t2).ratio()))


def title_matches(title: str, wanted: list[str], mode: str = "close") -> bool:
    t = " ".join(_words(title))
    for w in wanted:
        n = " ".join(_words(w))
        if not n:
            continue
        if mode == "exact":
            if t == n:
                return True
            continue
        a, b = _syn(title), _syn(w)
        if mode == "close" and a == b:
            return True
        # "close" also needs a shared word about the work itself: "QA Engineer" shares only "engineer" with "Detection Engineer" (scores 84)
        if token_set_ratio(a, b) >= THRESHOLD.get(mode, 80) and (mode != "close" or parse(title)[1] & parse(w)[1]):
            return True
        if mode == "broad" and _strip(b) and re.search(rf"\b{re.escape(_strip(b))}\b", _strip(a)):
            return True
    return False


def _stem(w: str) -> str:
    return w[:-1] if w.endswith("s") and not w.endswith("ss") and len(w) > 4 else w


def parse(title: str) -> tuple[set[str], set[str], set[str]]:
    """(role kinds, field words, other-line-of-work words): "Sr. SOC Analyst" -> ({"ic"}, {"security", "operation"}, set())."""
    words = [x for w in _words(title) for x in ABBR.get(w, w).split()]
    words = [w for w in words if w not in SENIORITY and w not in FILLER and not w.isdigit()]
    return {ROLE[w] for w in words if w in ROLE}, {_stem(w) for w in words if w not in ROLE}, {w for w in words if w in NEG}


def levels(v: str | list[str] | None) -> set[str]:
    """settings.filters.experience_level: a list of levels (older settings files hold one string)."""
    return {v} if isinstance(v, str) else set(v or ["mid"])


def wants_manager(wanted: list[str], level: str | list[str]) -> bool:
    return bool(levels(level) & {"lead", "manager", "director"}) or any("mgr" in parse(w)[0] for w in wanted)  # lead and manager are one rung


def role_ok(title: str, wanted: list[str], level: str | list[str] = "mid") -> bool:
    """False for a manager title when you aim below manager level, or a title from another line of work ("Security Sales Engineer")."""
    roles, _, neg = parse(title)
    mine = {w for t in wanted for w in _words(t)}
    return not neg - mine and ("mgr" not in roles or wants_manager(wanted, level))


def title_tier(title: str, f: dict) -> str | None:
    """"exact" when the title matches one of settings.filters.titles, "related" for one of filters.related_titles, else None."""
    wanted, related = f.get("titles") or [], f.get("related_titles") or []
    if not role_ok(title, wanted + related, f.get("experience_level", "mid")):
        return None
    if title_matches(title, wanted, f.get("title_match", "close")):
        return "exact"
    return "related" if related and title_matches(title, related, "close") else None


def _remote(c: dict, hybrid: bool = True) -> bool:
    return bool(re.search(r"remote|anywhere" + ("|hybrid" if hybrid else ""), f"{c.get('location', '')} {c.get('title', '')}", re.I))


def location_ok(c: dict, f: dict) -> bool:
    mode, loc = f.get("remote", "any"), (c.get("location") or "").lower()
    # "Austin, TX" is matched by its city: postings write "Austin", "Austin, Texas" or "Austin, TX, US" (the analyst checks the rest)
    places = [p.split(",")[0].strip().lower() for p in f.get("locations", []) if p.strip() and p.strip().lower() != "remote"]
    here = not places or not loc or any(re.search(rf"\b{re.escape(p)}\b", loc) for p in places if p)  # unknown location is judged later by the analyst
    if mode == "remote_only":
        return not loc or _remote(c, hybrid=False)  # a hybrid job still needs you in an office; an unknown place is read in full
    if mode == "onsite_only":
        return not _remote(c) and here
    if mode == "remote_or_hybrid":
        return _remote(c) or here
    return True


def window_hours(f: dict) -> int:
    """settings.filters.posted_within_hours; settings files written before it existed still say posted_within_days."""
    return int(f.get("posted_within_hours") or f.get("posted_within_days", 14) * 24)


def drop_reason(c: dict, f: dict, now: datetime | None = None, title_ok: bool | None = None) -> str | None:
    """`title_ok` True: the caller already judged the title (a related title, or a different title worth a look)."""
    if not (title_ok if title_ok is not None else title_tier(c.get("title", ""), f)):
        return "title"
    if not location_ok(c, f):
        return "location"
    title = (c.get("title") or "").lower()
    if any(k.strip() and k.lower() in title for k in f.get("exclude_keywords", [])):
        return "exclude_keyword"
    co = (c.get("company") or "").lower()
    if any(b.strip() and re.search(rf"\b{re.escape(b.lower())}\b", co) for b in f.get("company_blocklist", [])):
        return "company_blocklist"
    if c.get("posted"):
        try:
            when = datetime.fromisoformat(str(c["posted"]).replace("Z", "+00:00"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            if (now or datetime.now(timezone.utc)) - when > timedelta(hours=window_hours(f)):
                return "too_old"
        except ValueError:
            pass  # unparseable date: let it through
    lo, top = f.get("min_salary"), c.get("salary_max")
    if lo and (top is not None and top < 0.9 * lo or top is None and not f.get("allow_unknown_salary", True)):  # 10% slack: ranges are rough
        return "salary"
    return None
