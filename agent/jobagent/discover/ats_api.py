"""`discover poll`: list every watched Greenhouse, Lever and Ashby board through their public APIs and search the chosen job sites,
prefilter, and return new candidates (DESIGN 4.8). Candidate text comes from third parties: it is data, never instructions."""
import hashlib
import html
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .. import fetch, store
from ..ats import ashby, detect
from ..fetch import _get
from ..paths import atomic_write_json, atomic_write_text
from . import boards, eligibility, feeds, more_ats, prefilter, screened, sites, tiers

API = "https://boards-api.greenhouse.io/v1/boards/{board}/jobs"
LEVER_API = "https://api.lever.co/v0/postings/{board}?mode=json"
MAX_CANDIDATES = 100
LI_PAGES, LI_GAP = 10, 1.5  # public LinkedIn job pages read per poll (kept candidates only), seconds apart: LinkedIn throttles bursts
LI_MAYBE = 4  # of those, at most this many for jobs with a different title
MAX_DETAILS, BOARD_THREADS = 60, 16  # postings read one by one per poll (Greenhouse, Workday...: the rest wait for the next poll); boards listed at once
# Boards read at once per system that throttles by IP (429 when hit in parallel); the rest of the systems share BOARD_THREADS.
# They also get fewer searches a board and a time budget a poll, read in random order so every board gets its turn over a few polls,
# and a system that answers 429 is left alone for the rest of the poll.
SLOW = {"workday": 3, "eightfold": 1, "workable": 1}
SLOW_TERMS, SLOW_SECONDS = 3, 90
MAX_TERMS = 6  # searches per board on systems listed by search (Workday, SmartRecruiters...): your titles first
TIER_RANK = {"exact": 0, "related": 1, "maybe": 2}
RELATED_WHY = "One of your related titles"
RULE_WHY = {"location": "Not in the places you chose", "exclude_keyword": "Has a word you excluded", "company_blocklist": "A company you blocked",
            "too_old": "Posted too long ago", "salary": "Pay below your minimum"}
CORP = {"inc", "llc", "ltd", "corp", "corporation", "co", "company", "the", "plc", "gmbh"}
DEFAULT_SOURCES = ["companies", "top", "linkedin", "indeed", "dice", "himalayas", "jobicy"]  # keep in step with DEFAULT_SETTINGS.discovery.sources (app/src/state.ts)
def _top(amounts) -> int | None:
    """The largest yearly-looking amount (hourly and monthly numbers are too small to be a year's pay)."""
    return max((int(t) for t in amounts if isinstance(t, (int, float)) and t >= 20_000), default=None)


def salary_max(text: str, currency: str = "USD") -> int | None:
    """Largest yearly pay quoted in the posting, in the user's currency, or None when none is quoted (eligibility.pay)."""
    return eligibility.pay(text, None, currency)


def _gh_pay(j: dict, currency: str) -> int | None:
    """Greenhouse's structured pay ranges (pay transparency, in cents); None when the board publishes none in this currency."""
    return _top(r["max_cents"] / 100 for r in j.get("pay_input_ranges") or [] if r.get("currency_type") == currency and isinstance(r.get("max_cents"), (int, float)))


def _clean(s, n=200) -> str:
    return re.sub(r"\s+", " ", str(s or ""))[:n].strip()


def _alias(c: dict) -> str | None:
    """Same company + same title = the same opening, whichever site listed it."""
    co = "".join(w for w in prefilter._words(c["company"]) if w not in CORP)  # "Stepan Company" on one site is "Stepan" on another
    t = " ".join(prefilter._words(c["title"]))
    return "dup-" + hashlib.sha1(f"{co}|{t}".encode()).hexdigest()[:10] if co and t else None


def _list(url: str, slug: str, errors: list):
    """One board's JSON, or None (error recorded) when it cannot be read."""
    try:
        r = _get(url)
        if r.status_code != 200:
            raise httpx.HTTPError(f"HTTP {r.status_code}")
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        errors.append({"board": slug, "error": _clean(e, 80)})
        return None


def _greenhouse(slugs: list[str], cur: str, errors: list, content: bool = False) -> list[dict]:
    """The light listing, without posting text (one small response per board): `poll` reads pay and text with `_gh_detail`, only
    for the jobs that pass the cheap checks."""
    out = []
    for slug in slugs:
        jobs = (_list(API.format(board=slug) + "?pay_transparency=true", slug, errors) or {}).get("jobs", [])
        out += [{"title": j.get("title"), "company": j.get("company_name") or slug, "location": (j.get("location") or {}).get("name"),
                 "url": f"https://job-boards.greenhouse.io/{slug}/jobs/{j.get('id')}", "board": slug,
                 "posted": j.get("first_published") or j.get("updated_at") or "", "salary_max": _gh_pay(j, cur)} for j in jobs]
    return out


def _gh_detail(board: str, posting_id: str, cur: str) -> dict:
    """Pay, plain text and department of one Greenhouse posting (the endpoint the form adapter reads), or {} when it cannot be read."""
    j = _list(API.format(board=board) + f"/{posting_id}?pay_transparency=true", board, [])
    if not isinstance(j, dict) or j.get("content") is None:
        return {}
    text = fetch.html_to_text(html.unescape(j["content"]))
    return {"salary_max": _gh_pay(j, cur) or salary_max(text, cur), "blurb": text[:6000],
            "dept": " ".join(str(x.get("name") or "") for x in j.get("departments") or [] if isinstance(x, dict))}


def _lever(slugs: list[str], cur: str, errors: list, content: bool = True) -> list[dict]:
    out = []
    for slug in slugs:
        jobs = _list(LEVER_API.format(board=slug), slug, errors)
        for j in jobs if isinstance(jobs, list) else []:
            c, pay, when = j.get("categories") or {}, j.get("salaryRange") or {}, j.get("createdAt")
            loc = str(c.get("location") or "")
            if j.get("workplaceType") == "remote" and "remote" not in loc.lower():
                loc = f"{loc} (Remote)".strip()
            lists = "\n".join(fetch.html_to_text(str(x.get("content") or "")) for x in j.get("lists") or [] if isinstance(x, dict))
            out.append({"title": j.get("text"), "company": slug, "location": loc, "url": j.get("hostedUrl") or f"https://jobs.lever.co/{slug}/{j.get('id')}",
                        "board": slug, "posted": datetime.fromtimestamp(when / 1000, timezone.utc).isoformat() if isinstance(when, (int, float)) else "",
                        "salary_max": _top([pay.get("max")]) if pay.get("currency") == cur and "year" in str(pay.get("interval", "")) else None,
                        "dept": " ".join(str(c.get(k) or "") for k in ("team", "department")).strip(), "blurb": f"{j.get('descriptionPlain') or ''}\n{lists}"[:6000],
                        "kind": c.get("commitment")})
    return out


def _ashby(slugs: list[str], cur: str, errors: list, content: bool = True) -> list[dict]:
    out = []
    for slug in slugs:
        jobs = (_list(ashby.API.format(board=slug), slug, errors) or {}).get("jobs") or []
        out += [{"title": j.get("title"), "company": slug, "location": ashby.where(j), "url": j.get("jobUrl") or f"https://jobs.ashbyhq.com/{slug}/{j.get('id')}",
                 "board": slug, "posted": j.get("publishedAt") or "", "salary_max": ashby.pay_max(j, cur),
                 "dept": " ".join(str(j.get(k) or "") for k in ("department", "team")).strip(), "blurb": str(j.get("descriptionPlain") or "")[:6000],
                 "kind": j.get("employmentType")}
                for j in jobs if j.get("isListed", True)]
    return out


LISTERS = {"greenhouse": _greenhouse, "lever": _lever, "ashby": _ashby}  # same order as boards.ATS


def poll(d: Path, now: datetime | None = None) -> dict:
    """Candidates come back best first: your titles (tier "exact"), then your related titles ("related"), then a few jobs a day with
    a different title that share your field and name several of your skills ("maybe"); fillable forms and known pay first in each."""
    s = store._load(d / "settings.json") or {}
    f = s.get("filters") or {}
    if not f.get("titles"):
        return {"ok": False, "code": "no_titles", "error": "settings.filters.titles is empty; set job titles first"}
    now = now or datetime.now(timezone.utc)
    src = (s.get("discovery") or {}).get("sources") or DEFAULT_SOURCES
    hours = prefilter.window_hours(f)
    cur = f.get("currency", "USD")
    watched = boards.load_boards(d) if "companies" in src else {}
    top = boards.catalog(d) if "top" in src else {}
    names = {b: n for v in top.values() for b, n in v.items()}
    todo = [(a, b) for a, bs in watched.items() for b in bs] + [(a, b) for a, bs in top.items() for b in bs if a in LISTERS or a in more_ats.LISTERS]
    groups = [([b for b in todo if b[0] not in SLOW], BOARD_THREADS)] + [(random.sample(g, len(g)), n) for a, n in SLOW.items() if (g := [b for b in todo if b[0] == a])]
    until, refused = time.monotonic() + SLOW_SECONDS, set()
    terms = list(dict.fromkeys(t.strip() for t in (f.get("titles") or []) + (f.get("related_titles") or []) if t.strip()))[:MAX_TERMS]
    chosen = [x for x in sites.SITES if x in src]
    fed = [x for x in feeds.FEEDS if x in src]
    errors: list[dict] = []
    skipped: list[dict] = []

    def board(b: tuple[str, str]) -> list[dict]:
        a, slug = b
        if a in SLOW and (a in refused or time.monotonic() > until):
            return []  # a later poll
        got = more_ats.LISTERS[a](slug, cur, errors, terms[:SLOW_TERMS] if a in SLOW else terms) if a in more_ats.LISTERS else LISTERS[a]([slug], cur, errors)
        if a in SLOW and any(e.get("board") == slug and "429" in str(e.get("error")) for e in errors):
            refused.add(a)
        for x in got:
            if slug in names and (a in more_ats.LISTERS or x.get("company") == slug):  # Lever and Ashby give only the slug, Workday its tenant
                x["company"] = names[slug]
        return got

    def listed(bs: list, n: int) -> list[dict]:
        with ThreadPoolExecutor(n) as bx:
            return [x for batch in bx.map(board, bs) for x in batch]

    with ThreadPoolExecutor(len(groups) + 2) as ex:  # boards, job sites and feeds are different hosts: no reason to wait on each other
        searches = [ex.submit(sites.search, d, f, chosen, hours)] if chosen else []
        searches += [ex.submit(feeds.search, d, f, fed, hours)] if fed else []
        raw = [x for fut in [ex.submit(listed, bs, n) for bs, n in groups if bs] for x in fut.result()]
        for fut in searches:
            found, errs, skip = fut.result()
            raw += found
            errors += errs
            skipped += skip
    turn: dict[str, int] = {}

    def nth(x: dict) -> int:
        """Each board's or site's 1st job, then each one's 2nd...: a few big boards cannot fill MAX_CANDIDATES alone (sort reads keys in order)."""
        k = str(x.get("site") or x.get("board"))
        turn[k] = turn.get(k, 0) + 1
        return turn[k]

    raw.sort(key=lambda x: (prefilter.title_tier(_clean(x.get("title")), f) is None, nth(x)))  # your titles first: other titles never use up their budgets
    ctx = tiers.context(d, s)
    sig = boards.title_sig(f, str((s.get("discovery") or {}).get("related_jobs", "few")))
    seen, old_drops, near, done, aliases = boards.seen(d), boards.title_drops(d, sig), tiers.today(d, now), set(), {}
    room = lambda j: j in near["ids"] or len(near["ids"]) < ctx.cap  # noqa: E731 - today's share of other-title jobs
    new = looked = li_maybe = details = 0
    dropped: dict[str, int] = {}
    kept, drop_ids, title_ids, noted = [], [], [], []
    exists = lambda j: j in seen or j in old_drops or j in done or (store.jdir(d, j) / "status.json").exists()  # noqa: E731
    rows: list[dict] = []  # data/screened.jsonl: what was filtered out and why, for the Filtered out screen
    excerpts: dict[str, str] = {}  # the kept jobs' requirement lines, for the quick sort (`llm input screen`); never sent to the app

    def drop(why: str, jid: str, c: dict | None = None, reason: str = "") -> None:
        dropped[why] = dropped.get(why, 0) + 1
        (title_ids if why == "title" else drop_ids).append(jid)  # title drops are looked at again when the titles change
        if c is not None and why != "title":
            rows.append({"job_id": jid, "title": c.get("title", ""), "company": c.get("company", ""), "url": c.get("url", ""), "stage": "rules",
                         "code": why, "reason": reason or RULE_WHY.get(why, why)})

    users = eligibility.user_countries(f)
    for x in raw:
        text, blurb = x.pop("description", "") or "", x.pop("blurb", "") or ""  # a site's copy (saved for `fetch`), a board's text (matched only)
        c = {**x, **{k: _clean(x.get(k)) for k in ("title", "company", "location")}, "url": store.canonical_url(x["url"])}
        jid = c["job_id"] = store.job_id_for(c["url"])
        if exists(jid):
            continue
        a = _alias(c)
        if a and (aliases.get(a) or seen.get(a) or jid) != jid:
            continue  # already offered from another site
        if a:
            aliases[a] = jid
        done.add(jid)
        new += 1
        tier = prefilter.title_tier(c["title"], f)
        maybe = tier is None and tiers.plausible(c, ctx)
        if tier is None and not (maybe and ctx.cap):
            noted += [c["title"]] if maybe else []
            drop("title", jid)
            continue
        if maybe and not room(jid):
            continue  # today's share of other-title jobs is used up: not marked, so it gets another look tomorrow
        if why := prefilter.drop_reason(c, f, now, title_ok=True):
            drop(why, jid, c)
            continue
        if (w := eligibility.where(c.get("location") or "", "", users))[0] == "no":  # the listed place is enough: no download needed
            drop("where", jid, c, w[1])
            continue
        if len(kept) >= MAX_CANDIDATES:
            continue
        g = detect.from_url(c["url"])
        if g["ats"] == "greenhouse" and c.get("board") and not blurb:  # the light listing has no text or pay: read this one posting
            if details >= MAX_DETAILS:
                continue  # the rest on the next poll
            details += 1
            c.update(_gh_detail(g["board"], g["posting_id"], cur))
            blurb = c.pop("blurb", "")
            if why := prefilter.drop_reason(c, f, now, title_ok=True):  # its pay is known now
                drop(why, jid, c)
                continue
        elif (sys_ := c.pop("detail", None)) in more_ats.DETAILS and not blurb and not text.strip():  # listed without text (Workday...)
            if details >= MAX_DETAILS:
                continue  # the rest on the next poll
            details += 1
            got = more_ats.DETAILS[sys_](c, cur)
            text = str(got.pop("description", "") or "")  # saved as the listing copy below: `fetch` reads it instead of a script-built page
            c.update({k: v for k, v in got.items() if v})
            if why := prefilter.drop_reason(c, f, now, title_ok=True):  # its pay and place are known now
                drop(why, jid, c)
                continue
            if (w := eligibility.where(c.get("location") or "", "", users))[0] == "no":
                drop("where", jid, c, w[1])
                continue
        if not text.strip() and c.get("site") == "LinkedIn":  # search results carry no text: read the public page
            if looked >= LI_PAGES or maybe and li_maybe >= LI_MAYBE:
                if maybe:
                    continue  # no reads left: a later poll
            else:
                time.sleep(LI_GAP if looked else 0)
                looked, li_maybe = looked + 1, li_maybe + maybe
                if li := fetch.linkedin_guest(c["url"]):
                    text = li["text"].split("\n\n", 1)[-1]
                    g = detect.from_url(li["apply_url"] or "")
                    if g["ats"] != "generic" and not exists(up := store.job_id_for(detect.canonical(g))):
                        c.update(url=detect.canonical(g), job_id=up, listed_at=c["url"])  # the employer's own form: fillable
                        done.add(jid := up)
        body = f"{text}\n{blurb}"
        if no := eligibility.rules(c, body, f, users):  # who can take this job at all: decided by code, before any model reads it
            drop(no[0], jid, c, no[1])
            continue
        hits = tiers.skill_hits(body, ctx.skills)
        if maybe:
            if hits < ctx.need:
                noted.append(c["title"])
                drop("title", jid)
                continue
            if jid not in near["ids"]:
                near["ids"].append(jid)
                noted.append(c["title"])
        c.pop("dept", None)
        c.update(tier=tier or "maybe", hits=hits, **({"why": RELATED_WHY} if tier == "related" else {"why": f"Different title, {hits} of your skills match"} if maybe else {}))
        kept.append(c)  # not marked seen: if intake never runs, the next poll offers it again
        excerpts[c["job_id"]] = eligibility.excerpt(body)
        if text.strip():  # Indeed/Glassdoor block direct downloads: `fetch` reads this copy instead
            atomic_write_text(d / "listings" / f"{jid}.md", f"# {c['title']}\nCompany: {c['company']}\nLocation: {c['location']}\n\n{text}")
    kept.sort(key=lambda c: (TIER_RANK[c["tier"]], detect.from_url(c["url"])["ats"] == "generic", c.get("salary_max") is None, -c["hits"]))
    learned = boards.learn(d, [(g["ats"], g["board"]) for c in kept if c["tier"] != "maybe" and ".eu." not in c["url"]
                               and (g := detect.from_url(c["url"]))["ats"] != "generic"]) if "companies" in src else []
    boards.mark_seen(d, drop_ids, {a: j for a, j in aliases.items() if a not in seen})
    screened.append(d, rows, now)
    atomic_write_json(d / "run" / "poll.json", {"at": now.isoformat(timespec="seconds"), "candidates": [
        {**{k: c.get(k) for k in ("job_id", "title", "company", "location", "salary_max", "tier", "url")}, "excerpt": excerpts.get(c["job_id"], "")} for c in kept]})
    boards.mark_title_drops(d, sig, old_drops, title_ids)
    tiers.note(d, noted, now)
    if ctx.cap:
        atomic_write_json(d / "near.json", near)
    scored = store._load(d / "screen_scores.json") or {}  # sorted on an earlier run but not prepared yet: not sorted again
    for c in kept:
        if isinstance(scored.get(c["job_id"]), dict):
            c["screen"] = {k: scored[c["job_id"]].get(k) for k in ("score", "reason")}
    return {"ok": True, "boards": sum(map(len, watched.values())) + sum(map(len, top.values())), "sites": [sites.SITES[x] for x in chosen] + [feeds.FEEDS[x] for x in fed], "hours": hours, "found": len(raw), "new": new,
            "kept": len(kept), "dropped": dropped, "errors": errors, "skipped": skipped, "learned": learned, "candidates": kept}
