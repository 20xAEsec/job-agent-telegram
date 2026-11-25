"""data/boards.json (the boards to poll), data/seen.json (jobs already surfaced, so none appears twice), data/title_drops.json (jobs
dropped for their title, looked at again when the titles change) and data/boards_learned.json (boards found in search results)."""
import hashlib
import json
import re
from pathlib import Path

from .. import store
from ..paths import atomic_write_json

ATS = ("greenhouse", "lever", "ashby")
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,60}$")
LEARN_PER_POLL, LEARN_MAX = 5, 60


def _load(p: Path, empty):
    return store._load(p) or empty


def load_boards(d: Path) -> dict:
    b = _load(d / "boards.json", {})
    return {a: b.get(a, []) for a in ATS}


def add(d: Path, ats: str, slugs: list[str]) -> dict:
    bad = [s for s in slugs if not SLUG.match(s.lower())]
    if bad:
        return {"ok": False, "code": "bad_slug", "error": f"not a board slug: {', '.join(bad)}"}
    b = load_boards(d)
    b[ats] = sorted(set(b[ats]) | {s.lower() for s in slugs})
    atomic_write_json(d / "boards.json", b)
    return {"ok": True, "boards": b}


def remove(d: Path, ats: str, slugs: list[str]) -> dict:
    """`ats` "any": from every ATS (the Companies screen lists slugs without their ATS)."""
    b = load_boards(d)
    for a in ATS if ats == "any" else [ats]:
        b[a] = [s for s in b[a] if s not in {x.lower() for x in slugs}]
    atomic_write_json(d / "boards.json", b)
    atomic_write_json(d / "boards_blocked.json", sorted(set(_load(d / "boards_blocked.json", [])) | {x.lower() for x in slugs}))  # never re-learned
    return {"ok": True, "boards": b}


def learn(d: Path, found: list[tuple[str, str]]) -> list[str]:
    """Watch employer boards that search results led to (a posting that fit, on the employer's own Greenhouse, Lever or Ashby board):
    at most LEARN_PER_POLL a poll and LEARN_MAX ever, never one the user removed. Returns the slugs added."""
    learned = _load(d / "boards_learned.json", {})
    skip = {s for v in load_boards(d).values() for s in v} | set(_load(d / "boards_blocked.json", [])) | set(learned)
    new: dict[str, str] = {}
    for a, s in found:
        if a in ATS and SLUG.match(s := s.lower()) and s not in skip:
            new.setdefault(s, a)
    picked = list(new.items())[:max(0, min(LEARN_PER_POLL, LEARN_MAX - len(learned)))]
    for s, a in picked:
        add(d, a, [s])
        learned[s] = {"ats": a, "at": store.now()}
    if picked:
        atomic_write_json(d / "boards_learned.json", learned)
    return [s for s, _ in picked]


def _probe(ats: str, slug: str) -> tuple[str, int | None] | None:
    """(company name, open jobs) when `slug` is a board on `ats`, else None. Network errors propagate."""
    from ..ats.ashby import API as ASHBY
    from ..fetch import _get
    from .ats_api import LEVER_API

    if ats == "greenhouse":
        r = _get(f"https://boards-api.greenhouse.io/v1/boards/{slug}")
        if r.status_code != 200:
            return None
        jobs = _get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
        return str(r.json().get("name") or slug), len(jobs.json().get("jobs", [])) if jobs.status_code == 200 else None
    r = _get(LEVER_API.format(board=slug) if ats == "lever" else ASHBY.format(board=slug))
    jobs = (r.json() if ats == "lever" else r.json().get("jobs")) if r.status_code == 200 else None
    # shortcut: an Ashby board with no open jobs reads as missing (unknown boards may answer 200 with no jobs); fine for "watch this company"
    if not isinstance(jobs, list) or (ats == "ashby" and not jobs):
        return None
    return slug.replace("-", " ").title(), len(jobs)


def check(slug: str, ats: str | None = None) -> dict:
    """Is there a Greenhouse, Lever or Ashby board called `slug` (first found, in that order)? Returns which, its company name and
    open job count (used before adding from Telegram)."""
    slug = slug.lower()
    if not SLUG.match(slug):
        return {"ok": False, "code": "bad_slug", "error": "not a board name"}
    for a in [ats] if ats else ATS:
        try:
            hit = _probe(a, slug)
        except Exception as e:  # noqa: BLE001 - network: report the type only
            return {"ok": False, "code": "network", "error": type(e).__name__}
        if hit:
            return {"ok": True, "ats": a, "slug": slug, "company": hit[0][:80], "open_jobs": hit[1]}
    return {"ok": False, "code": "not_found", "error": f"no Greenhouse, Lever or Ashby job board called {slug}"}


def seen(d: Path) -> dict:
    return _load(d / "seen.json", {})


def mark_seen(d: Path, ids: list[str], aliases: dict | None = None) -> None:
    """`aliases` maps a `dup-` company+title key to the job id that owns it, so a job listed on several sites is offered once."""
    if ids or aliases:
        atomic_write_json(d / "seen.json", {**seen(d), **{i: store.now() for i in ids}, **(aliases or {})})


def title_sig(f: dict, related_jobs: str) -> str:
    """Changes when anything that decides a title drop changes, so jobs dropped under the old titles get another look."""
    key = [sorted(f.get("titles") or []), sorted(f.get("related_titles") or []), f.get("title_match", "close"), f.get("experience_level", "mid"), related_jobs]
    return hashlib.sha1(json.dumps(key).encode()).hexdigest()[:12]


def title_drops(d: Path, sig: str) -> set[str]:
    st = _load(d / "title_drops.json", {})
    return set(st.get("ids") or []) if st.get("sig") == sig else set()


def mark_title_drops(d: Path, sig: str, old: set[str], ids: list[str]) -> None:
    """`old`: title_drops(d, sig) as read before the poll (empty after a change, so the old list is replaced)."""
    if ids:
        atomic_write_json(d / "title_drops.json", {"sig": sig, "ids": sorted(old | set(ids))})
