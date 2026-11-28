"""Per-job state under data/jobs/<id>/: ids, meta.json, and the status machine (DESIGN 6.1). Only this module writes status.json."""
import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .ats import detect
from .paths import atomic_write_json, locked
from .profile import JOB_RE


class JobError(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(msg)
        self.code = code


TERMINAL = {"SKIPPED", "SUBMITTED", "DRY_RUN_DONE", "CLOSED", "APPLIED_SELF"}
FLOW = {
    "NEW": {"FETCHED"}, "FETCHED": {"SCORED"}, "SCORED": {"NEEDS_ANSWERS", "READY", "KIT_READY"},
    # A form JobAgent cannot fill: a kit (tailored resume, drafted answers) for the user to apply with, then their "I applied" tap.
    "KIT_READY": {"APPLIED_SELF", "READY"},
    "NEEDS_ANSWERS": {"READY"}, "READY": {"NEEDS_ANSWERS", "FILLED_DRY"},
    "FILLED_DRY": {"AWAITING_APPROVAL", "READY", "NEEDS_ANSWERS"}, "AWAITING_APPROVAL": {"APPROVED", "READY"},
    "APPROVED": {"SUBMITTING", "READY"}, "SUBMITTING": {"SUBMITTED", "FAILED", "NEEDS_HUMAN", "DRY_RUN_DONE"},
    "NEEDS_HUMAN": {"READY", "KIT_READY", "APPLIED_SELF"}, "FAILED": {"NEW", "READY", "APPLIED_SELF"},
    "SKIPPED": {"SCORED"},  # "Apply anyway" on a skipped job (the user overrides the filters)
    "DRY_RUN_DONE": {"READY", "APPLIED_SELF"},  # "Apply for real" after a practice run: prepared and approved again
}
STATUSES = set(FLOW) | TERMINAL


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def jdir(d: Path, job_id: str) -> Path:
    if not JOB_RE.match(job_id or ""):
        raise JobError("bad_job_id", "job id must match [a-z0-9-]{1,80}")
    return d / "jobs" / job_id


def _load(p: Path):
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def meta(d: Path, job_id: str) -> dict:
    m = _load(jdir(d, job_id) / "meta.json")
    if m is None:
        raise JobError("no_job", f"unknown job {job_id}")
    return m


def status(d: Path, job_id: str) -> dict:
    s = _load(jdir(d, job_id) / "status.json")
    if s is None:
        raise JobError("no_job", f"unknown job {job_id}")
    return s


def canonical_url(url: str) -> str:
    g = detect.from_url(url)
    if g["ats"] != "generic":
        return detect.canonical(g)
    u = urlsplit(url.strip())
    qs = parse_qs(u.query)
    host = (u.hostname or "").lower()
    if host == "linkedin.com" or host.endswith(".linkedin.com"):  # search/collection pages name the job in ?currentJobId=
        m = re.search(r"/jobs/view/(?:[^/]*-)?(\d+)", u.path)  # /jobs/view/123 or /jobs/view/data-analyst-at-acme-123
        li = qs.get("currentJobId", [m[1] if m else ""])[0]
        if li.isdigit():
            return f"https://www.linkedin.com/jobs/view/{li}"
    if (host == "indeed.com" or host.endswith(".indeed.com")) and qs.get("vjk") and not qs.get("jk"):  # search page with a job open
        return f"https://{host}/viewjob?jk={qs['vjk'][0]}"
    # the query param that names the posting: company page (gh_jid), Indeed (jk), Glassdoor (jl), ZipRecruiter (jid)
    k = next((k for k in ("gh_jid", "jk", "jl", "jid") if qs.get(k)), None)
    q = f"?{k}={qs[k][0]}" if k else ""
    return f"{u.scheme.lower()}://{(u.netloc or '').lower()}{u.path.rstrip('/')}{q}"


def job_id_for(canonical: str) -> str:
    g = detect.from_url(canonical)
    jid = re.sub(r"[^a-z0-9]+", "-", f"{g['ats']}-{g.get('board')}-{g.get('posting_id')}".lower()).strip("-")
    if g["ats"] != "generic" and JOB_RE.match(jid):
        return jid
    return "web-" + hashlib.sha1(canonical.encode()).hexdigest()[:10]


def new_job(d: Path, url: str, source: str = "manual") -> dict:
    if not re.match(r"^https?://[^\s]+$", url or ""):
        raise JobError("bad_url", "expected an http(s) URL")
    cu = canonical_url(url)
    jid = job_id_for(cu)
    if (jdir(d, jid) / "status.json").exists():
        return {"ok": True, "job_id": jid, "duplicate": True, "status": status(d, jid)["status"]}
    atomic_write_json(jdir(d, jid) / "meta.json", {"job_id": jid, "url": url, "canonical_url": cu, "source": source, "created_at": now(), **detect.from_url(cu)})
    atomic_write_json(jdir(d, jid) / "status.json", {"status": "NEW", "updated_at": now(), "history": [{"status": "NEW", "at": now(), "detail": ""}]})
    return {"ok": True, "job_id": jid, "duplicate": False, "status": "NEW"}


def update_meta(d: Path, job_id: str, **kw) -> None:
    atomic_write_json(jdir(d, job_id) / "meta.json", {**meta(d, job_id), **kw})


def allowed(cur: str, new: str) -> bool:
    if new in FLOW.get(cur, ()):
        return True
    if cur in TERMINAL:
        return new == "CLOSED" and cur != "CLOSED"
    return new in ("NEEDS_HUMAN", "FAILED", "CLOSED") or (new == "SKIPPED" and cur != "SUBMITTING")


def set_status(d: Path, job_id: str, new: str, detail: str = "") -> dict:
    if new not in STATUSES:
        raise JobError("bad_status", f"unknown status {new}")
    status(d, job_id)  # unknown job: fail here, before the lock creates its folder
    with locked(jdir(d, job_id) / "status.json"):  # the transition check and the write must see the same status
        s = status(d, job_id)
        if s["status"] == new:
            return {"ok": True, "job_id": job_id, "status": new}
        if not allowed(s["status"], new):
            raise JobError("bad_transition", f"{s['status']} -> {new} is not allowed")
        t = now()
        atomic_write_json(jdir(d, job_id) / "status.json", {"status": new, "updated_at": t, "history": s["history"] + [{"status": new, "at": t, "detail": detail[:200]}]})
    if new not in ("NEW", "FETCHED"):
        from . import log

        log.upsert(d, job_id)
    return {"ok": True, "job_id": job_id, "status": new}


# What is left of a deleted job that was really sent: enough to refuse applying twice and to keep the daily and company limits.
KEEP_SENT = {"meta.json", "status.json", "analysis.json", "receipt.json"}


def delete_job(d: Path, job_id: str) -> dict:
    """Remove a job (a duplicate, a link sent by mistake): its folder and history row. Auto-search never offers it again.
    A job that was really sent keeps a small hidden record (`deleted_at`); nothing can unsend it."""
    status(d, job_id)  # unknown job: fail here, before the lock creates its folder
    from . import log
    from .discover import boards

    j = jdir(d, job_id)
    with locked(j / "status.json"):
        s = status(d, job_id)
        if s["status"] in ("APPROVED", "SUBMITTING"):
            raise JobError("sending", "this job is being sent: stop or skip it first")
        sent = any(h.get("status") == "SUBMITTED" for h in s["history"])
        if sent:
            update_meta(d, job_id, deleted_at=now())
            for p in j.iterdir():
                if p.is_dir():
                    shutil.rmtree(p)
                elif p.name not in KEEP_SENT and p.name != "status.json.lock":
                    p.unlink()
    if not sent:
        shutil.rmtree(j)
    log.remove(d, job_id)
    boards.mark_seen(d, [job_id])
    return {"ok": True, "job_id": job_id, "sent": sent}


def summary(d: Path, job_id: str) -> dict:
    m, s = meta(d, job_id), status(d, job_id)
    a = _load(jdir(d, job_id) / "analysis.json") or {}
    return {"job_id": job_id, "status": s["status"], "updated_at": s["updated_at"], "url": m["canonical_url"], "ats": m.get("ats", "generic"),
            "source": m.get("source", ""), "company": str(a.get("company", "")), "role": str(a.get("role", "")),
            "score": (a.get("match") or {}).get("score") if isinstance(a.get("match"), dict) else None}


def list_jobs(d: Path, only: str | None = None, deleted: bool = False) -> list[dict]:
    """`deleted`: include the records kept for deleted jobs that were sent (the send limits count them)."""
    out = []
    for p in sorted((d / "jobs").glob("*/status.json")) if (d / "jobs").is_dir() else []:
        try:
            if not deleted and meta(d, p.parent.name).get("deleted_at"):
                continue
            x = summary(d, p.parent.name)
        except JobError:
            continue
        if only is None or x["status"] == only:
            out.append(x)
    return sorted(out, key=lambda x: x["updated_at"], reverse=True)


def get_job(d: Path, job_id: str) -> dict:
    j = jdir(d, job_id)
    return {"ok": True, **summary(d, job_id), "history": status(d, job_id)["history"][-8:],
            "files": sorted(p.name for p in j.iterdir() if p.is_file() and p.name != "posting.md")}
