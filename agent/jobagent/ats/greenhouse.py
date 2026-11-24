"""Greenhouse (new job-boards UI: every control's id is the API field name, selects are react-select comboboxes).
Verified read-only against live postings in stage d; the submit/confirmation/email-code path is NOT verified live."""
import html
import json
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .. import safety
from ..paths import atomic_write_json
from .base import Adapter, Closed, Unexpected, match_option, read_back

API = "https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}"
TYPES = {"input_text": "text", "textarea": "textarea", "input_file": "file",
         "multi_value_single_select": "select", "multi_value_multi_select": "multiselect"}
SUBMIT = 'button[type="submit"]'
# Page-side scan for something a human has to deal with. The invisible reCAPTCHA badge (.grecaptcha-logo) is normal on Greenhouse.
BLOCKER_JS = """() => {
  const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const caps = [...document.querySelectorAll('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="challenge" i], .h-captcha, .g-recaptcha, [data-sitekey]')]
    .filter(e => !e.closest('.grecaptcha-badge, .grecaptcha-logo') && e.getAttribute('data-size') !== 'invisible' && vis(e))
  if (caps.length || /just a moment|verify you are human|are you a robot/i.test(document.title + ' ' + (document.body.innerText || '').slice(0, 400))) return 'captcha'
  if (/error=true/.test(location.search)) return 'closed'
  if ([...document.querySelectorAll('input[type=password]')].some(vis)) return 'login'
  return null
}"""
# Form controls on the page that no field accounts for (the phone country picker and react-select internals are normal).
EXTRA_JS = """() => [...document.querySelectorAll('form input:not([type=hidden]), form select, form textarea')]
  .filter(e => e.id && !/^(country|iti-|react-select|g-recaptcha)/.test(e.id)).map(e => [e.id, e.required || e.getAttribute('aria-required') === 'true'])"""


class Greenhouse(Adapter):
    name = "greenhouse"

    @staticmethod
    def allowed_hosts(meta):
        return ["greenhouse.io", (urlsplit(meta.get("url", "")).hostname or "greenhouse.io")]

    @staticmethod
    def apply_url(meta):
        return f"https://job-boards.greenhouse.io/{meta['board']}/jobs/{meta['posting_id']}"

    @staticmethod
    def api_job(meta, questions=False) -> dict:
        r = httpx.get(API.format(board=meta["board"], id=meta["posting_id"]), params={"questions": "true"} if questions else None, timeout=20)
        if r.status_code == 404:
            raise Closed("posting not found")
        r.raise_for_status()
        return r.json()

    def posting_text(self, meta):
        from ..fetch import html_to_text

        j = self.api_job(meta)
        loc = (j.get("location") or {}).get("name", "")
        return f"# {j.get('title', '')}\nCompany: {j.get('company_name', '')}\nLocation: {loc}\n\n{html_to_text(html.unescape(j.get('content', '')))}"

    def inspect(self, meta, d=None, prepare=None):
        return fields_from_api(self.api_job(meta, questions=True))

    def detect_blockers(self, page):
        return page.evaluate(BLOCKER_JS)

    def extra_on_page(self, page, fields: dict) -> tuple[list[str], list[str]]:
        """(ids the API did not list, the required ones among them)"""
        known = {f["selector"][5:-2] for f in fields.values()}  # [id="x"] -> x
        x = [(i, r) for i, r in page.evaluate(EXTRA_JS) if i not in known]
        return sorted(i for i, _ in x), sorted(i for i, r in x if r)

    def fill(self, page, plan_fields, fields, jdir):
        """Type the plan into the form. Never presses Enter and never clicks a submit control."""
        rep = {"filled": [], "errors": [], "missing_on_page": []}
        for p in plan_fields:
            f, act = fields.get(p["fid"]), p.get("action")
            if f is None or act == "skip":
                continue
            loc = page.locator(f["selector"])
            if loc.count() == 0:
                rep["missing_on_page"].append(p["fid"])
                continue
            try:
                self._one(page, loc.first, f, act, p.get("value"), jdir)
                rep["filled"].append(p["fid"])
            except Exception as e:  # noqa: BLE001 - report the field and the error type, never the value
                rep["errors"].append({"fid": p["fid"], "error": type(e).__name__})
        return read_back(page, plan_fields, fields, rep)

    def _one(self, page, loc, f, act, value, jdir):
        if act == "upload":
            loc.set_input_files(str(safety.upload_path(jdir, value)))
        elif act == "check":
            loc.set_checked(bool(value))
        elif act == "select":
            for v in [match_option(f["options"], v) or v for v in (value if isinstance(value, list) else [value])]:  # the page's own spelling
                if loc.evaluate("e => e.tagName") == "SELECT":
                    loc.select_option(label=str(v))
                else:
                    self._pick(page, loc, str(v), exact=bool(f["options"]))
        elif act == "fill":
            loc.fill(str(value))
        else:
            raise Unexpected(f"unknown action {act!r}")

    def _pick(self, page, loc, label, exact=True):
        """react-select: focus, type to filter, click the option. No Enter key anywhere."""
        if loc.get_attribute("role") != "combobox":
            raise Unexpected("not a combobox")
        loc.click()
        loc.fill(label)
        page.get_by_role("option", name=label, exact=exact).first.click(timeout=5000)
        if label not in loc.locator("xpath=ancestor::*[contains(@class,'select__control')][1]").inner_text():
            raise Unexpected("option not selected")

    # ---- submit side: only reachable through `jobagent submit` (safety.click_submit checks) ----

    @staticmethod
    def confirmed(page) -> bool:
        return "/confirmation" in page.url or page.get_by_text("Thank you for applying").count() > 0

    def submit(self, page, d: Path, job_id: str) -> bool:
        safety.click_submit(page, d, job_id, SUBMIT)
        for _ in range(2):  # at most one email-code round
            end = time.time() + 45
            while time.time() < end:
                if self.confirmed(page):
                    return True
                boxes = page.locator('input[id^="security-input"]')
                if boxes.count():
                    code = wait_for_code(d / "jobs" / job_id)
                    if not code:
                        raise Unexpected("no email code received")
                    for i, ch in enumerate(code[: boxes.count()]):
                        boxes.nth(i).fill(ch)
                    safety.click_submit(page, d, job_id, SUBMIT)
                    break
                page.wait_for_timeout(1000)
        return self.confirmed(page)


def wait_for_code(jdir: Path, timeout=600, poll=2.0) -> str | None:
    """Ask the channel (needs_input.json) for the emailed code and wait for input.json."""
    atomic_write_json(jdir / "needs_input.json", {"kind": "email_code", "at": time.time()})
    end = time.time() + timeout
    while time.time() < end:
        try:
            code = str(json.loads((jdir / "input.json").read_text("utf-8")).get("value", "")).strip()
        except (OSError, ValueError):
            code = ""
        if code:
            for n in ("input.json", "needs_input.json"):
                (jdir / n).unlink(missing_ok=True)
            return code
        time.sleep(poll)
    (jdir / "needs_input.json").unlink(missing_ok=True)
    return None


def _field(q: dict, f: dict, first: bool, section: str) -> dict:
    return {"fid": f["name"], "label": str(q.get("label", "")).strip(), "type": TYPES.get(f["type"], f["type"]),
            "required": bool(q.get("required")) and first,  # resume / resume_text share one question: only the first is required
            "options": [str(v["label"]) for v in f.get("values") or []], "selector": f'[id="{f["name"]}"]', "section": section}


def fields_from_api(job: dict) -> list[dict]:
    out = []
    groups = [("main", job.get("questions") or []), ("location", job.get("location_questions") or [])]
    groups += [("compliance", c.get("questions") or []) for c in job.get("compliance") or []]
    for section, qs in groups:
        for q in qs:
            for i, f in enumerate(q.get("fields") or []):
                if f["type"] == "input_hidden":  # latitude / longitude: set by the page itself
                    continue
                x = _field(q, f, i == 0, section)
                if section == "location" and f["name"] == "location":  # the page's place-autocomplete combobox
                    x.update(type="select", selector='[id="candidate-location"]')
                out.append(x)
    demo = job.get("demographic_questions") or {}
    for q in demo.get("questions") or []:  # newer EEO format; ids as DOM selectors are unverified
        out.append({"fid": f"demographic_{q['id']}", "label": str(q.get("label", "")).strip(), "type": TYPES.get(q.get("type"), "select"),
                    "required": bool(q.get("required")), "options": [str(o["label"]) for o in q.get("answer_options") or []],
                    "selector": f'[id="{q["id"]}"]', "section": "demographic"})
    return out
