"""data/boards.json (the boards to poll) and data/seen.json (jobs already surfaced, so none appears twice)."""
import re
from pathlib import Path

from .. import store
from ..paths import atomic_write_json

ATS = ("greenhouse",)
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,60}$")


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
    b = load_boards(d)
    b[ats] = [s for s in b[ats] if s not in {x.lower() for x in slugs}]
    atomic_write_json(d / "boards.json", b)
    return {"ok": True, "boards": b}


def check(slug: str) -> dict:
    """Does this Greenhouse board exist? Returns its company name and open job count (used before adding from Telegram)."""
    from ..fetch import _get

    if not SLUG.match(slug.lower()):
        return {"ok": False, "code": "bad_slug", "error": "not a board name"}
    try:
        r = _get(f"https://boards-api.greenhouse.io/v1/boards/{slug.lower()}")
        jobs = _get(f"https://boards-api.greenhouse.io/v1/boards/{slug.lower()}/jobs") if r.status_code == 200 else None
    except Exception as e:  # noqa: BLE001 - network: report the type only
        return {"ok": False, "code": "network", "error": type(e).__name__}
    if r.status_code != 200:
        return {"ok": False, "code": "not_found", "error": f"no Greenhouse board called {slug}"}
    name = str(r.json().get("name") or slug)[:80]
    count = len(jobs.json().get("jobs", [])) if jobs is not None and jobs.status_code == 200 else None
    return {"ok": True, "slug": slug.lower(), "company": name, "open_jobs": count}


def seen(d: Path) -> dict:
    return _load(d / "seen.json", {})


def mark_seen(d: Path, ids: list[str], aliases: dict | None = None) -> None:
    """`aliases` maps a `dup-` company+title key to the job id that owns it, so a job listed on several sites is offered once."""
    if ids or aliases:
        atomic_write_json(d / "seen.json", {**seen(d), **{i: store.now() for i in ids}, **(aliases or {})})
