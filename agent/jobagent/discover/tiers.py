"""Jobs worth a look under a title the user did not list ("maybe" tier), from deterministic signals only (no Claude):
the title shares the user's field and kind of role, and the posting text names several of the user's own skills.
The skills are matched here, locally, against text auto-search already fetched; they never go into a search.
Candidate text is third-party data: it is only matched against, never followed."""
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from .. import profile, store
from ..paths import atomic_write_json
from . import prefilter

CAPS = {"off": 0, "few": 4, "more": 12}  # settings.discovery.related_jobs: other-title jobs admitted per local day
# Field words too general to tie two titles together on their own ("Security Operations" and "IT Operations").
WEAK = {"information", "technology", "technical", "system", "operation", "service", "support", "general", "business", "digital", "center",
        "solution", "it"}
SEEN_TITLES, MAX_SEEN_TITLES = "seen_titles.json", 300


@dataclass
class Ctx:
    wanted: list[str]  # filters.titles + filters.related_titles
    level: str
    field: set[str]  # field words of the wanted titles
    roles: set[str]  # their role kinds
    skills: list[str]
    cap: int

    @property
    def need(self) -> int:
        """Skills a posting must name: 3, or 2 when the profile lists fewer than 8."""
        return 2 if len(self.skills) < 8 else 3


def skills(d: Path) -> list[str]:
    """The profile's skills (every `- key: a, b` line under ## Skills), lowercased, at most 40."""
    try:
        fields = profile.show(d, "Skills")["fields"]
    except profile.ProfileError:
        return []
    out: list[str] = []
    for v in fields.values():
        for x in re.split(r"[,;()]|\s/\s", v):  # "CI/CD" stays one skill
            x = x.strip().lower()
            if len(x) >= 2 and x not in out:
                out.append(x)
    return out[:40]


def context(d: Path, s: dict) -> Ctx:
    f = s.get("filters") or {}
    wanted = [t for t in (f.get("titles") or []) + (f.get("related_titles") or []) if t.strip()]
    field, roles = set(), set()
    for t in wanted:
        r, w, _ = prefilter.parse(t)
        roles, field = roles | r, field | w
    cap = CAPS.get((s.get("discovery") or {}).get("related_jobs", "few"), CAPS["few"])
    return Ctx(wanted, f.get("experience_level", "mid"), field, roles, skills(d), cap)


def skill_hits(text: str, skills: list[str]) -> int:
    """How many different skills the text names, as whole words ("C++" and "CI/CD" included; "Java" does not match "JavaScript")."""
    t = text[:8000].lower()
    return sum(1 for k in skills if re.search(rf"(?<![a-z0-9+#]){re.escape(k)}(?![a-z0-9+#])", t))


def plausible(c: dict, ctx: Ctx) -> bool:
    """A title outside the user's lists that could still be their kind of job: not another line of work, not a manager role they
    did not ask for, the same kind of role, and a field word shared with their titles (in the title, or the board's department/team)."""
    title = c.get("title") or ""
    if not prefilter.role_ok(title, ctx.wanted, ctx.level):
        return False
    roles, words, _ = prefilter.parse(title)
    if roles and ctx.roles and not roles & ctx.roles:  # "Data Entry Clerk" for an analyst
        return False
    need = (ctx.field - WEAK) or ctx.field
    return bool((words | prefilter.parse(c.get("dept") or "")[1]) & need)


def today(d: Path, now: datetime) -> dict:
    """data/near.json: the other-title jobs admitted today (local day). An id stays admitted for the rest of the day."""
    day = now.astimezone().date().isoformat()
    st = store._load(d / "near.json") or {}
    return st if st.get("day") == day and isinstance(st.get("ids"), list) else {"day": day, "ids": []}


def _show(title: str) -> str:
    """"Sr. SOC Analyst (Remote)" -> "SOC Analyst": the title as offered for the related-titles list."""
    return " ".join(w for w in re.findall(r"[A-Za-z0-9+#]+", title) if w.lower() not in prefilter.SENIORITY | prefilter.FILLER)[:60]


def note(d: Path, titles: list[str], now: datetime) -> None:
    """Count titles auto-search keeps seeing in the user's field (data/seen_titles.json: {key: {t, n, last}}). The app offers the ones
    seen at least twice lately under Settings → Related titles; only the user's tap adds one."""
    if not titles:
        return
    st = store._load(d / SEEN_TITLES) or {}
    for t in titles:
        if show := _show(t):
            e = st.get(k := show.lower()) or {"t": show, "n": 0}
            st[k] = {**e, "n": e["n"] + 1, "last": now.isoformat()}
    old = (now - timedelta(days=60)).isoformat()
    keep = sorted(((k, v) for k, v in st.items() if v.get("last", "") >= old), key=lambda kv: kv[1].get("last", ""), reverse=True)
    atomic_write_json(d / SEEN_TITLES, dict(keep[:MAX_SEEN_TITLES]))
