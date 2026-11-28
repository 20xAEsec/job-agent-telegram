"""Greenhouse (new job-boards UI: every control's id is the API field name, selects are react-select comboboxes).
Verified read-only against live postings in stage d; the submit/confirmation/email-code path is NOT verified live."""
import html
import json
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .. import browser, safety
from ..paths import atomic_write_json
from .base import Adapter, Closed, Unexpected, fill_rows, match_option, pick

API = "https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}"
TYPES = {"input_text": "text", "textarea": "textarea", "input_file": "file",
         "multi_value_single_select": "select", "multi_value_multi_select": "multiselect"}
SUBMIT = 'button[type="submit"]'
SKIP_IDS = r"^(?:g-recaptcha|h-captcha|cf-turnstile|iti-|react-select)"  # page controls that are not questions
# Page-side scan for something a human has to deal with. The invisible reCAPTCHA badge (.grecaptcha-logo) is normal on Greenhouse.
BLOCKER_JS = """() => {
  const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  // any captcha frame (reCAPTCHA, hCaptcha, DataDome, a site's own), Cloudflare and Arkose challenges, PerimeterX's press-and-hold
  const caps = [...document.querySelectorAll('iframe[src*="captcha"], iframe[title*="challenge" i], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], #px-captcha, .h-captcha, .g-recaptcha, [data-sitekey]')]
    .filter(e => !e.closest('.grecaptcha-badge, .grecaptcha-logo') && e.getAttribute('data-size') !== 'invisible' && vis(e))
  if (caps.length || /just a moment|verify you are human|are you a robot/i.test(document.title + ' ' + (document.body.innerText || '').slice(0, 400))) return 'captcha'
  if (/error=true/.test(location.search)) return 'closed'
  if ([...document.querySelectorAll('input[type=password]')].some(vis)) return 'login'
  return null
}"""
# Form controls on the page that no field accounts for (the phone country picker and react-select internals are normal).
EXTRA_JS = """() => [...document.querySelectorAll('form input:not([type=hidden]), form select, form textarea')]
  .filter(e => e.id && !/^(country|iti-|react-select|g-recaptcha)/.test(e.id)).map(e => [e.id, e.required || e.getAttribute('aria-required') === 'true'])"""


DISABLED_JS = "() => [...document.querySelectorAll('form input, form select, form textarea')].filter(e => e.disabled).map(e => e.name || e.id)"
# The nearest heading above a control inside the form (Employment, Education): the closest ancestor holding one wins.
HEADING_JS = """(sel) => { const e = document.querySelector(sel), form = e && e.closest('form')
  for (let x = e && e.parentElement; x && x !== form; x = x.parentElement) {
    const hs = [...x.querySelectorAll('h1, h2, h3, h4, legend, [class*="header"]')].filter(h => h.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)
    const t = hs.length ? (hs[hs.length - 1].innerText || '').replace(/\\s+/g, ' ').trim() : ''
    if (t) return t }
  return '' }"""


class Greenhouse(Adapter):
    name = "greenhouse"

    @staticmethod
    def allowed_hosts(meta):
        return ["greenhouse.io", (urlsplit(meta.get("url", "")).hostname or "greenhouse.io")]

    @staticmethod
    def apply_url(meta):
        # The embed form never redirects: /{board}/jobs/{id} sends companies with their own careers site (Dropbox) there, behind Cloudflare.
        return f"https://job-boards.greenhouse.io/embed/job_app?for={meta['board']}&token={meta['posting_id']}"

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
        """The API's questions (clean labels and options), plus every control the rendered form has that the API never lists:
        country, employment, education, follow-ups. Without the page (blocked, down) the API alone, as before."""
        api = fields_from_api(self.api_job(meta, questions=True))
        try:
            return api + (self.page_fields(meta, api, d, prepare) or [])
        except Exception:  # noqa: BLE001 - the check after filling names any box this misses
            return api

    def scan(self, page):
        from .formscan import scan_form  # formscan imports this module

        return scan_form(page, ["form#application-form", "form"], ".field-wrapper, .file-upload, fieldset", ["label", "legend"], SKIP_IDS)

    def page_fields(self, meta, api: list[dict], d=None, prepare=None) -> list[dict] | None:
        from .formscan import as_fields, harvest

        known = {f["selector"][5:-2] for f in api} | {f["fid"] for f in api}  # [id="x"] -> x
        with browser.session(d, self.allowed_hosts(meta)) as ctx:
            if prepare:
                prepare(ctx)
            page = ctx.new_page()
            page.goto(self.apply_url(meta), wait_until="load", timeout=45000)
            page.wait_for_selector("form input", state="attached", timeout=20000)
            if self.detect_blockers(page):
                return None
            rows = [r for r in self.scan(page) or [] if r["fid"] not in known and not any(r["fid"].startswith(k + "_") for k in known)]
            for r in rows:  # "Title" alone is ambiguous: say which part of the form it is in ("Employment: Title")
                h = r["group"] or page.evaluate(HEADING_JS, r["selector"]) if ">>" not in r["selector"] else ""
                if h and len(h) <= 40 and h.casefold() not in r["label"].casefold():
                    r["label"] = f'{h}: {r["label"]}'
            for c in [r for r in rows if r["type"] == "checkbox"]:  # boxes another answer greys out ("Current role" -> end date)
                try:
                    tick = page.locator(c["selector"]).first
                    before = set(page.evaluate(DISABLED_JS))
                    tick.set_checked(True)
                    off = set(page.evaluate(DISABLED_JS)) - before
                    tick.set_checked(False)
                except Exception:  # noqa: BLE001 - left as the page shows it
                    continue
                for r in rows:
                    if r["fid"] in off:
                        r.update(required=False, label=f'{r["label"]} (leave empty when "{c["label"]}" is ticked)')
            harvest(page, rows)
        return as_fields(rows)

    def detect_blockers(self, page):
        return page.evaluate(BLOCKER_JS)

    def extra_on_page(self, page, fields: dict) -> tuple[list[str], list[str]]:
        """(ids the API did not list, the required ones among them)"""
        known = {f["selector"][5:-2] for f in fields.values()}  # [id="x"] -> x
        x = [(i, r) for i, r in page.evaluate(EXTRA_JS) if i not in known and not any(i.startswith(k + "_") for k in known)]  # a known checkbox group's boxes
        return sorted(i for i, _ in x), sorted(i for i, r in x if r)

    def empty_required(self, page, fields):
        from .formscan import empty_required

        return empty_required(self.scan(page) or [], fields)

    def fill(self, page, plan_fields, fields, jdir):
        """Type the plan into the form. Never presses Enter and never clicks a submit control."""
        return fill_rows(page, plan_fields, fields, self._one, jdir)

    def _one(self, page, loc, f, act, value, jdir):
        loc = loc.first
        if act == "upload":
            path = safety.upload_path(jdir, value)
            loc.set_input_files(str(path))
            try:  # taken: the upload buttons give way to the file's name. Refused: the field shows an error and no name
                page.get_by_text(path.name, exact=True).first.wait_for(timeout=20000)
            except Exception:  # noqa: BLE001
                raise Unexpected("the site did not take the file") from None
        elif act == "check":
            loc.set_checked(bool(value))
        elif act == "select":
            tag = loc.evaluate("e => e.tagName")
            vals = [str(match_option(f["options"], v) or v) for v in (value if isinstance(value, list) else [value])]  # the page's own spelling
            if tag == "SELECT":
                loc.select_option(label=vals)  # all at once: one call per value would keep only the last
                return
            for v in vals:
                if tag == "FIELDSET":  # "select all that apply" drawn as checkboxes
                    loc.get_by_label(str(v), exact=True).set_checked(True)
                else:
                    pick(page, loc, str(v), exact=bool(f["options"]))
        elif act == "fill":
            loc.fill(str(value))
        else:
            raise Unexpected(f"unknown action {act!r}")

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
