"""`fill <id> --dry-run`: type plan.json into the live form and screenshot it. Never submits (there is no submit call in this module)."""
import json
from pathlib import Path

from . import browser, safety, store
from .ats import detect
from .ats.base import Unexpected, match_option
from .paths import atomic_write_json


def _read(j: Path, name: str):
    try:
        return json.loads((j / name).read_text("utf-8"))
    except (OSError, ValueError):
        raise store.JobError("missing_file", f"{name} is missing or not valid JSON") from None


def check_plan(plan, fields: dict) -> list[dict]:
    rows = plan.get("fields") if isinstance(plan, dict) else None
    if not isinstance(rows, list) or not all(isinstance(r, dict) and r.get("fid") in fields and r.get("action") in ("fill", "select", "check", "upload", "skip") for r in rows):
        raise store.JobError("bad_plan", "plan.json must be {fields:[{fid, action: fill|select|check|upload|skip, value, source}]} with fids from fields.json")
    if len({r["fid"] for r in rows}) != len(rows):
        raise store.JobError("bad_plan", "a fid appears twice in plan.json")
    vals = lambda r: r.get("value") if isinstance(r.get("value"), list) else [r.get("value")]  # noqa: E731
    off = [r["fid"] for r in rows if r["action"] == "select" and fields[r["fid"]]["options"]
           and any(match_option(fields[r["fid"]]["options"], v) is None for v in vals(r))]
    if off:  # caught before a browser opens, with the fields named
        raise store.JobError("bad_plan", f"select values must be one of the field's options (fields.json): {', '.join(off)}")
    return rows


def fill_job(d: Path, job_id: str, dry_run: bool, prepare=None) -> dict:
    """`prepare(context)` is a test hook that runs before the first navigation (it serves saved fixtures)."""
    if not dry_run:
        return {"ok": False, "code": "dry_run_required", "error": "fill only runs with --dry-run; submitting is done by the channel server"}
    if store.status(d, job_id)["status"] != "READY":
        raise store.JobError("bad_status", "fill needs a job in status READY")
    j, m = store.jdir(d, job_id), store.meta(d, job_id)
    ad = detect.adapter_for(m)
    if ad is None:
        raise store.JobError("no_adapter", "only Greenhouse, Lever and Ashby forms can be filled")
    fields = {f["fid"]: f for f in _read(j, "fields.json")}
    rows = check_plan(_read(j, "plan.json"), fields)
    ph = safety.plan_hash(j)  # also proves every upload exists
    (j / "screenshots").mkdir(exist_ok=True)
    shot = j / "screenshots" / "filled.png"
    blocker = report = extra = extra_req = None
    with browser.session(d, ad.allowed_hosts(m)) as ctx:
        if prepare:
            prepare(ctx)
        page = ctx.new_page()
        try:
            page.goto(ad.apply_url(m), wait_until="load", timeout=45000)
            first = next(iter(fields.values()))["selector"] if fields else "form"
            try:
                page.wait_for_selector(first, state="attached", timeout=15000)  # attached: file inputs are often hidden
            except Exception:  # noqa: BLE001 - the blocker scan below explains why
                pass
            blocker = ad.detect_blockers(page)
            if blocker is None:
                if page.locator(first).count() == 0:
                    raise Unexpected("form not found on the page")
                report = ad.fill(page, rows, fields, j)
                extra, extra_req = ad.extra_on_page(page, fields)
        except Unexpected as e:
            blocker = f"unexpected: {e}"
        except Exception as e:  # noqa: BLE001 - navigation blocked by the domain guard, timeout, crashed page
            blocker = f"unexpected: {type(e).__name__}"
        try:
            page.screenshot(path=str(shot), full_page=True)
        except Exception:  # noqa: BLE001
            shot = None
    if blocker == "closed":
        store.set_status(d, job_id, "CLOSED", "posting gone")
    if blocker:
        atomic_write_json(j / "fill_report.json", {"plan_hash": ph, "blocker": blocker})
        if blocker != "closed":
            store.set_status(d, job_id, "NEEDS_HUMAN", blocker[:100])
        return {"ok": False, "code": "closed" if blocker == "closed" else "needs_human", "reason": blocker, "screenshot": str(shot) if shot else None,
                "error": f"{blocker}: a person has to look at this page"}
    planned = {r["fid"] for r in rows if r["action"] != "skip"}
    unplanned = [f for f, x in fields.items() if x["required"] and f not in planned]  # required on the page, nothing planned
    unplanned += extra_req  # a required control the API never listed: nothing can fill it
    problems = bool(report["errors"] or report["missing_on_page"] or unplanned)
    out = {"plan_hash": ph, **report, "unplanned_required": unplanned, "extra_on_page": extra, "screenshot": str(shot) if shot else None}
    atomic_write_json(j / "fill_report.json", out)
    if problems:
        return {"ok": False, "code": "plan_mismatch", "error": "the plan and the page disagree: fix the plan or ask the user", **{k: out[k] for k in ("errors", "missing_on_page", "unplanned_required", "extra_on_page")}}
    store.set_status(d, job_id, "FILLED_DRY", "dry fill ok")
    return {"ok": True, "filled": len(report["filled"]), "extra_on_page": extra, "screenshot": out["screenshot"]}
