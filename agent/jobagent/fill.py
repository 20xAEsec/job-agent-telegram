"""`fill <id> --dry-run`: type plan.json into the live form and screenshot it. `handoff <id>`: the same in a window the user
finishes themselves. Never submits (there is no submit call in this module)."""
import json
import time
from pathlib import Path

from . import browser, safety, store
from .ats import detect
from .ats.base import Unexpected, match_option
from .paths import atomic_write_json


PLAIN = {
    "captcha": 'The form shows an "are you a human" check, which I never solve. You can finish it yourself',
    "login": "The form wants you to log in or create an account, which I never do. Please apply on the site",
    "unexpected": "The form page was not what I expected, so I stopped before sending anything",
}


def _left_for_you(left: list[dict]) -> str:
    """The job card's line when required boxes are still empty after filling (labels are page text: short, no values)."""
    names = ", ".join(x["label"][:40] for x in left[:4]) + (f" and {len(left) - 4} more" if len(left) > 4 else "")
    return f"I filled the form but these required boxes are still empty: {names}. Tap Open filled form to finish them"


# Outline each box still empty and say so at the top. Page text goes in with textContent, never as HTML; the note takes no clicks.
MARK_JS = """([sels, note]) => {
  for (const s of sels) { const e = document.querySelector(s); if (!e) continue
    const b = e.closest('.field-wrapper, fieldset, [class*="control"]') || e; b.style.outline = '3px solid #e5484d'; b.style.outlineOffset = '4px' }
  const n = document.createElement('div'); n.textContent = note
  n.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#e5484d;color:#fff;font:600 15px/1.4 system-ui,sans-serif;pointer-events:none'
  document.body.appendChild(n)
}"""


def _mark(page, left: list[dict]) -> None:
    if not left:
        return
    note = f"JobAgent: {len(left)} required {'box is' if len(left) == 1 else 'boxes are'} still empty (outlined in red): " + ", ".join(x["label"][:40] for x in left)
    try:
        page.evaluate(MARK_JS, [[x["selector"] for x in left if ">>" not in x["selector"]], note])
    except Exception:  # noqa: BLE001 - the window still works without the outline
        pass


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
        raise store.JobError("no_adapter", "only Greenhouse, Lever, Ashby, Breezy, Recruitee and Rippling forms can be filled")
    fields = {f["fid"]: f for f in _read(j, "fields.json")}
    rows = check_plan(_read(j, "plan.json"), fields)
    ph = safety.plan_hash(j)  # also proves every upload exists
    (j / "screenshots").mkdir(exist_ok=True)
    shot = j / "screenshots" / "filled.png"
    blocker = report = extra = extra_req = None
    left: list[dict] = []
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
                left = ad.empty_required(page, fields)  # the whole page, not just the plan: what a person would still have to do
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
            store.set_status(d, job_id, "NEEDS_HUMAN", PLAIN.get(blocker, PLAIN["unexpected"]))  # the user reads this on the job's card
        return {"ok": False, "code": "closed" if blocker == "closed" else "needs_human", "reason": blocker, "screenshot": str(shot) if shot else None,
                "error": f"{blocker}: a person has to look at this page"}
    planned = {r["fid"] for r in rows if r["action"] != "skip"}
    unplanned = [f for f, x in fields.items() if x["required"] and f not in planned and not x.get("prefilled")]  # required, nothing planned (a box the page fills itself is fine; empty_required checks it)
    unplanned += extra_req  # a required control the API never listed: nothing can fill it
    missing = [f for f in report["missing_on_page"] if fields[f]["required"]]  # an optional follow-up that never appeared is fine
    problems = bool(report["errors"] or missing or unplanned or left)
    out = {"plan_hash": ph, **report, "unplanned_required": unplanned, "extra_on_page": extra, "empty_required": [x["fid"] for x in left],
           "screenshot": str(shot) if shot else None}
    atomic_write_json(j / "fill_report.json", out)
    if left:  # say exactly which boxes, on the card, instead of "the form didn't match"
        store.set_status(d, job_id, "NEEDS_HUMAN", _left_for_you(left))
        return {"ok": False, "code": "needs_human", "reason": "empty_required", "empty_required": [x["label"] for x in left],
                "error": "required boxes are still empty after filling: a person has to finish them"}
    if problems:
        return {"ok": False, "code": "plan_mismatch", "error": "the plan and the page disagree: fix the plan or ask the user", **{k: out[k] for k in ("errors", "missing_on_page", "unplanned_required", "extra_on_page")}}
    store.set_status(d, job_id, "FILLED_DRY", "dry fill ok")
    return {"ok": True, "filled": len(report["filled"]), "extra_on_page": extra, "screenshot": out["screenshot"]}


def handoff(d: Path, job_id: str, prepare=None, wait: int = 3600, headless: bool = False) -> dict:
    """A window on the user's screen with the form filled in from plan.json, for them to finish and send themselves (a human
    check, an odd field). Never clicks a submit control. Returns once they have sent it, closed the window, or `wait` passed."""
    if store.status(d, job_id)["status"] not in ("NEEDS_HUMAN", "FAILED"):
        raise store.JobError("bad_status", "handoff needs a job in status NEEDS_HUMAN or FAILED")
    j, m = store.jdir(d, job_id), store.meta(d, job_id)
    ad = detect.adapter_for(m)
    if ad is None:
        raise store.JobError("no_adapter", "only Greenhouse, Lever, Ashby, Breezy, Recruitee and Rippling forms can be filled")
    fields = {f["fid"]: f for f in _read(j, "fields.json")}
    rows = check_plan(_read(j, "plan.json"), fields)
    safety.plan_hash(j)  # proves every upload exists
    report, sent, left = None, False, []
    try:
        with browser.session(d, ad.allowed_hosts(m), headless=headless, profile=True) as ctx:
            if prepare:
                prepare(ctx)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            end = time.time() + wait
            page.goto(ad.apply_url(m), wait_until="load", timeout=45000)
            # a full-page human check comes before the form: wait while the user passes it
            page.wait_for_selector(next(iter(fields.values()))["selector"], state="attached", timeout=wait * 1000)
            report = ad.fill(page, rows, fields, j)
            left = ad.empty_required(page, fields)
            _mark(page, left)
            browser.raise_window(page.title())
            already = ad.confirmed(page)  # "thank you" wording on the form itself must not count as sent
            while time.time() < end:
                page.wait_for_timeout(min(2000, wait * 1000))  # raises once the user closes the window
                if not already and ad.confirmed(page):
                    sent = True
                    page.wait_for_timeout(5000)  # let them see the confirmation
                    break
    except Exception as e:  # noqa: BLE001 - the window was closed, the profile is in use, or the page never loaded
        if "user data directory is already in use" in str(e).lower() or "processsingleton" in str(e).lower():
            return {"ok": False, "code": "busy", "error": "a JobAgent browser window is already open; close it and try again"}
        if report is None:
            return {"ok": False, "code": "not_filled", "error": f"the form could not be filled in ({type(e).__name__})"}
    if sent and store.status(d, job_id)["status"] != "APPLIED_SELF":  # they may have tapped "I applied" already
        store.set_status(d, job_id, "APPLIED_SELF", "you sent it from the window I filled in")
    bad = [x["fid"] for x in report["errors"]] + report["missing_on_page"] if report else []
    unfilled = [fields[i]["label"] for i in bad if i in fields]
    return {"ok": True, "submitted": sent, "unfilled": unfilled + [x["label"] for x in left if x["label"] not in unfilled]}
