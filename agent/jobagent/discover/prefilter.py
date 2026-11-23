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
        if token_set_ratio(a, b) >= THRESHOLD.get(mode, 80):
            return True
        if mode == "broad" and _strip(b) and re.search(rf"\b{re.escape(_strip(b))}\b", _strip(a)):
            return True
    return False


def _remote(c: dict) -> bool:
    return bool(re.search(r"remote|anywhere|hybrid", f"{c.get('location', '')} {c.get('title', '')}", re.I))


def location_ok(c: dict, f: dict) -> bool:
    mode, loc = f.get("remote", "any"), (c.get("location") or "").lower()
    places = [p.lower() for p in f.get("locations", []) if p.strip() and p.strip().lower() != "remote"]
    here = not places or not loc or any(p in loc for p in places)  # unknown location is judged later by the analyst
    if mode == "remote_only":
        return _remote(c)
    if mode == "onsite_only":
        return not _remote(c) and here
    if mode == "remote_or_hybrid":
        return _remote(c) or here
    return True


def window_hours(f: dict) -> int:
    """settings.filters.posted_within_hours; settings files written before it existed still say posted_within_days."""
    return int(f.get("posted_within_hours") or f.get("posted_within_days", 14) * 24)


def drop_reason(c: dict, f: dict, now: datetime | None = None) -> str | None:
    if not title_matches(c.get("title", ""), f.get("titles", []), f.get("title_match", "close")):
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
    if lo and (top is not None and top < lo or top is None and not f.get("allow_unknown_salary", True)):
        return "salary"
    return None
