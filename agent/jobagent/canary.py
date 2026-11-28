"""`canary [--live URL]`: dry-fill every adapter against its recorded form (no network, practice mode forced on) and report what broke,
so a broken adapter is caught before a user hits it. `--live` also reads one real posting's form (opens the page, types nothing).
Never submits: fill runs with --dry-run semantics and JOBAGENT_DRY_RUN=1, in a throwaway data folder."""
import json
import os
import tempfile
from pathlib import Path

from . import fill, store
from .ats import detect
from .ats.greenhouse import fields_from_api

# shortcut: the recorded forms live with the tests (repo installs only); package them if JobAgent ever ships as a wheel.
FX = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
LV, AB = "11111111-1111-4111-8111-111111111111", "0a1b2c3d-0000-4000-8000-00000000000"
RP = "96601a74-0000-4000-8000-000000000001"
P = lambda fid, action, value, source="profile": {"fid": fid, "action": action, "value": value, "source": source}  # noqa: E731
CASES = {
    "greenhouse": {"url": "https://job-boards.greenhouse.io/acme/jobs/123", "form": "gh_form.html", "api": "gh_job.json", "plan": [
        P("first_name", "fill", "Jane"), P("last_name", "fill", "Doe"), P("email", "fill", "jane@example.com"), P("phone", "fill", "+1 555 0100"),
        P("resume", "upload", "resume.pdf", "document"), P("question_100", "fill", "https://linkedin.com/in/janedoe"),
        P("question_101", "select", "Yes", "user"), P("question_102", "select", "No", "user"), P("question_103", "fill", "I like widgets.", "generated"),
        P("question_104", "select", "they/them", "user"), P("gender", "select", "Decline To Self Identify", "user")]},
    "lever": {"url": "https://jobs.lever.co/acme/2f3c9a1e-5b6d-4c7e-8f90-1a2b3c4d5e6f", "form": "lever_form.html", "plan": [
        P("resume", "upload", "resume.pdf", "document"), P("name", "fill", "Jane Doe"), P("email", "fill", "jane@example.com"), P("phone", "fill", "+1 555 0100"),
        P("urls[LinkedIn]", "fill", "https://linkedin.com/in/janedoe"), P("location", "fill", "Austin"), P(f"cards[{LV}][field0]", "select", "Yes", "user"),
        P(f"cards[{LV}][field1]", "select", ["SQL", "Python"]), P(f"cards[{LV}][field2]", "fill", "I like widgets.", "generated"),
        P(f"cards[{LV}][field3]", "select", "LinkedIn"), P("eeo[gender]", "select", "Decline to self-identify", "user")]},
    "ashby": {"url": "https://jobs.ashbyhq.com/acme/7d1e2f3a-4b5c-4d6e-9f70-8a9b0c1d2e3f", "form": "ashby_form.html", "plan": [
        P("_systemfield_name", "fill", "Jane Doe"), P("_systemfield_email", "fill", "jane@example.com"), P("_systemfield_resume", "upload", "resume.pdf", "document"),
        P("_systemfield_location", "select", "Austin, TX"), P("choice-4", "select", "No", "user"), P(f"{AB}2", "select", "3-5"),
        P(f"{AB}4", "select", "Decline to self-identify", "user")]},
    "breezy": {"url": "https://acme.breezy.hr/p/1a2b3c4d5e6f-data-analyst", "form": "breezy_form.html", "plan": [
        P("cResume", "upload", "resume.pdf", "document"), P("cName", "fill", "Jane Doe"), P("cEmail", "fill", "jane@example.com"),
        P("cPhoneNumber", "fill", "+1 555 0100"), P("q_auth", "select", "Yes", "user"), P("q_start", "fill", "2026-12-01", "user"),
        P("cSummary", "fill", "I like widgets.", "generated")]},
    "recruitee": {"url": "https://acme.recruitee.com/o/data-analyst", "form": "recruitee_form.html", "plan": [
        P("candidate.name", "fill", "Jane Doe"), P("candidate.email", "fill", "jane@example.com"), P("candidate.phone", "fill", "+1 555 0100"),
        P("candidate.cv", "upload", "resume.pdf", "document"), P("candidate.openQuestionAnswers.101.flag", "select", "Yes", "user"),
        P("candidate.openQuestionAnswers.102.content", "fill", "95000", "user"), P("candidate.locations.value", "select", ["Amsterdam"], "user")]},
    "rippling": {"url": f"https://ats.rippling.com/acme/jobs/{RP}", "form": "rippling_form.html", "plan": [
        P("input-resume", "upload", "resume.pdf", "document"), P("input-first_name", "fill", "Jane"), P("input-last_name", "fill", "Doe"),
        P("input-email", "fill", "jane@example.com"), P("input-phone_number", "fill", "5550100"), P("input-undefined", "fill", "Austin"),
        P("eeoc.gender", "select", "Decline to self-identify", "user"), P("sms_opt_in", "select", "No - I do not consent to receiving text messages", "user")]},
}


def serve(ctx, url: str, html: str, events: list):
    """Answer the form's URL with the recorded page; record every spy hit and every request that is not a GET."""
    ctx.route(url, lambda r: r.fulfill(status=200, content_type="text/html", body=html))
    ctx.route("**/__spy*", lambda r: (events.append(f"spy {r.request.url.split('k=')[-1]}"), r.fulfill(status=204)))
    ctx.on("request", lambda r: r.method != "GET" and events.append(f"{r.method} request"))


def prepared(d: Path, name: str, events: list, html: str | None = None, plan: list | None = None) -> tuple[str, object]:
    """A READY job for one case in data folder `d`: fields.json from the recorded API or form, the case's plan, a dummy resume.
    Returns (job id, the `prepare` hook that serves the form)."""
    c = CASES[name]
    jid = store.new_job(d, c["url"])["job_id"]
    m, j = store.meta(d, jid), store.jdir(d, jid)
    ad = detect.adapter_for(m)
    page = html if html is not None else (FX / c["form"]).read_text("utf-8")
    hook = lambda ctx: serve(ctx, ad.apply_url(m), page, events)  # noqa: E731
    fields = fields_from_api(json.loads((FX / c["api"]).read_text("utf-8"))) if c.get("api") else ad.inspect(m, d, hook)
    (j / "fields.json").write_text(json.dumps(fields), "utf-8")
    (j / "plan.json").write_text(json.dumps({"fields": plan if plan is not None else c["plan"]}), "utf-8")
    (j / "resume.pdf").write_bytes(b"%PDF-1.4 canary resume")
    for s in ("FETCHED", "SCORED", "READY"):
        store.set_status(d, jid, s)
    return jid, hook


def _case(root: Path, name: str) -> str | None:
    d = root / name
    d.mkdir()
    events: list[str] = []
    try:
        jid, hook = prepared(d, name, events)
        res = fill.fill_job(d, jid, True, prepare=hook)
    except Exception as e:  # noqa: BLE001 - any crash is a canary failure
        return f"{type(e).__name__}: {str(e)[:120]}"
    if events:
        return f"the page saw {', '.join(sorted(set(events)))}: nothing may submit or press Enter"
    if not res.get("ok"):
        keys = ("reason", "errors", "missing_on_page", "unplanned_required")
        return f"{res.get('code')}: " + json.dumps({k: res[k] for k in keys if res.get(k)})[:300]
    return None


def live(root: Path, url: str) -> dict:
    """Read one real posting's form (page open, nothing typed) and check it still looks like an application form."""
    d = root / "live"
    d.mkdir()
    jid = store.new_job(d, url)["job_id"]
    m = store.meta(d, jid)
    ad = detect.adapter_for(m)
    if ad is None:
        return {"url": url, "ok": False, "error": "not a posting on a form JobAgent can fill"}
    try:
        fields = ad.inspect(m, d)
    except Exception as e:  # noqa: BLE001
        return {"url": url, "ok": False, "error": f"{type(e).__name__}: {str(e)[:120]}"}
    has_file = any(f["type"] == "file" for f in fields)
    has_email = any("email" in (f["fid"] + f["label"]).lower() for f in fields)
    return {"url": url, "ok": has_file and has_email, "fields": len(fields), **({} if has_file and has_email else {"error": "no resume upload or email field found"})}


def run(live_url: str | None = None) -> dict:
    os.environ["JOBAGENT_DRY_RUN"] = "1"  # belt and braces: nothing in this process can submit
    with tempfile.TemporaryDirectory(prefix="jobagent-canary-") as tmp:
        root = Path(tmp)
        failures = [{"adapter": n, "error": e} for n in CASES if (e := _case(root, n))]
        out = {"ok": not failures, "checked": list(CASES), "failures": failures}
        if live_url:
            out["live"] = live(root, live_url)
            out["ok"] = out["ok"] and out["live"]["ok"]
    if not out["ok"]:
        out.update(code="canary_failed", error="an application form adapter is broken: " + ", ".join([f["adapter"] for f in failures] + (["live"] if live_url and not out["live"]["ok"] else [])))
    return out
