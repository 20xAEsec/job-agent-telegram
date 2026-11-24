"""Base for ATSs with no public form-schema API (Lever, Ashby): the rendered form is the schema.
`inspect` scans the page into fields.json rows; `fill` types the plan in and reads it back. Never presses Enter and never clicks
a submit control: the only submit click is `submit` -> safety.click_submit. Form labels are third-party text (data)."""
import re
import time

from .. import browser, safety
from .base import Adapter, Closed, Unexpected, match_option, read_back
from .greenhouse import BLOCKER_JS

# Every form control, grouped by name (radio/checkbox groups), with the question text from its container.
# A container with no control but a few plain buttons ("Yes" / "No") is a question answered by clicking one of them.
SCAN_JS = r"""([roots, box, labels, skip]) => {
  const form = roots.map(s => document.querySelector(s)).find(Boolean)
  if (!form) return null
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const txt = e => e ? (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() : ''
  const lab = e => e.closest('label') || (e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null)
  const head = q => { for (const s of labels) { const h = q && q.querySelector(s); if (txt(h)) return txt(h) } return '' }
  const sect = e => { const s = e.closest('fieldset, [class*="section"], [class*="Section"]'); return txt(s && s.querySelector('legend, h1, h2, h3, h4, [class*="title"], [class*="heading"]')).slice(0, 120) }
  const reqIn = q => !!(q && q.querySelector('.required, [class*="required"], [class*="Required"]'))
  const groups = new Map()
  for (const e of form.querySelectorAll('input, select, textarea')) {
    const t = (e.type || '').toLowerCase(), key = e.name || e.id, tick = t === 'radio' || t === 'checkbox'
    if (!key || /^(hidden|submit|button|reset|image)$/.test(t) || new RegExp(skip).test(key)) continue
    if (!(t === 'file' || shown(e) || (tick && shown(lab(e))))) continue
    if (!groups.has(key)) groups.set(key, { by: e.name ? 'name' : 'id', els: [] })
    groups.get(key).els.push(e)
  }
  const used = new Set(), out = []
  for (const [key, g] of groups) {
    const e = g.els[0], t = (e.type || '').toLowerCase(), tag = e.tagName, q = e.closest(box), tick = t === 'radio' || t === 'checkbox'
    if (q) used.add(q)
    const label = (tick ? head(q) || txt(lab(e)) : head(q) || txt(lab(e))) || e.getAttribute('aria-label') || e.placeholder || key
    const many = t === 'radio' || (t === 'checkbox' && g.els.length > 1)
    const type = tag === 'TEXTAREA' ? 'textarea' : tag === 'SELECT' ? (e.multiple ? 'multiselect' : 'select') : t === 'file' ? 'file'
      : t === 'radio' ? 'select' : t === 'checkbox' ? (many ? 'multiselect' : 'checkbox') : e.getAttribute('role') === 'combobox' ? 'select' : 'text'
    const options = tag === 'SELECT' ? [...e.options].filter(o => o.value !== '' && !o.disabled).map(txt) : many ? g.els.map(x => txt(lab(x)) || x.value) : []
    out.push({ key, by: g.by, label, type, options, section: sect(e),
               required: g.els.some(x => x.required || x.getAttribute('aria-required') === 'true') || /[*✱]\s*$/.test(label) || reqIn(q) })
  }
  form.querySelectorAll(box).forEach((q, i) => {
    if (used.has(q)) return
    const b = [...q.querySelectorAll('button[type="button"]')].filter(shown)
    if (b.length < 2 || b.length > 8 || b.some(x => !txt(x) || txt(x).length > 40)) return
    out.push({ key: `choice-${i}`, by: 'box', index: i, label: head(q) || `choice ${i}`, type: 'select', options: b.map(txt), section: sect(q),
               required: /[*✱]\s*$/.test(head(q)) || reqIn(q) })
  })
  return out
}"""
EEO = re.compile(r"equal employment|\beeoc?\b|self[- ]identif|demographic|diversity|\bgender\b|\brace\b|ethnicity|hispanic|latino|veteran|disabilit", re.I)
CLOSED = re.compile(r"no longer (?:available|accepting|open)|job not found|page not found|couldn.t find|posting (?:is )?closed|\b404\b", re.I)
SENT = re.compile(r"thank(?:s| you) for (?:applying|your (?:application|interest))|application (?:was |has been )?(?:submitted|received)", re.I)


def _q(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"')


class DomAdapter(Adapter):
    ROOTS: list[str] = ["form"]  # the application form, first match wins
    BOX = ""                     # one question's container
    LABELS: list[str] = []       # the question text inside BOX, tried in order
    SKIP = r"^(?:g-recaptcha|h-captcha|cf-turnstile)"  # control names that are not questions
    SUBMIT = 'button[type="submit"]'
    HOSTS: list[str] = []
    WAIT = 20000                 # ms for a single-page app to render its form

    @classmethod
    def allowed_hosts(cls, meta):
        return list(cls.HOSTS)

    # ---- reading the form ----

    def scan(self, page) -> list[dict] | None:
        rows = page.evaluate(SCAN_JS, [self.ROOTS, self.BOX, self.LABELS or ["label"], self.SKIP])
        if rows is None:
            return None
        out = []
        for r in rows:
            sel = f'{self.BOX} >> nth={r["index"]}' if r["by"] == "box" else f'[{r["by"]}="{_q(r["key"])}"]'
            label = re.sub(r"\s*[*✱]\s*$", "", r["label"]).strip()[:300]
            sec = "demographic" if r["key"].startswith("eeo") or EEO.search(f'{r["section"]} {label}') else "compliance" if r["key"].startswith("consent") else "main"
            out.append({"fid": r["key"], "label": label, "type": r["type"], "required": bool(r["required"]), "options": [o[:200] for o in r["options"]],
                        "selector": sel, "section": sec})
        return out

    def _root(self, page) -> bool:
        return any(page.locator(s).count() for s in self.ROOTS)

    def detect_blockers(self, page):
        b = page.evaluate(BLOCKER_JS)
        if b or self._root(page):
            return b
        return "closed" if CLOSED.search(page.inner_text("body")[:3000]) else None

    def inspect(self, meta, d=None, prepare=None):
        """Open the apply page (domain guard on, no typing) and scan its form."""
        with browser.session(d, self.allowed_hosts(meta)) as ctx:
            if prepare:
                prepare(ctx)
            page = ctx.new_page()
            page.goto(self.apply_url(meta), wait_until="load", timeout=45000)
            try:
                page.wait_for_selector(", ".join(f"{r} input" for r in self.ROOTS), state="attached", timeout=self.WAIT)  # single-page apps render late
            except Exception:  # noqa: BLE001 - the blocker scan says why
                pass
            b = self.detect_blockers(page)
            if b == "closed":
                raise Closed("posting gone")
            if b:
                raise Unexpected(b)
            fields = self.scan(page)
        if not fields:
            raise Unexpected("form not found on the page")
        return fields

    def extra_on_page(self, page, fields):
        now = self.scan(page) or []
        x = [f for f in now if f["fid"] not in fields]  # e.g. a follow-up question that appeared after an answer
        return sorted(f["fid"] for f in x), sorted(f["fid"] for f in x if f["required"])

    # ---- typing the plan in ----

    def fill(self, page, plan_fields, fields, jdir):
        """Uploads first (some forms re-fill name and email from the resume), then the rest, then read every typed value back."""
        rep = {"filled": [], "errors": [], "missing_on_page": []}
        rows = [p for p in plan_fields if p.get("action") != "skip" and p["fid"] in fields]
        rows.sort(key=lambda p: p.get("action") != "upload")
        for i, p in enumerate(rows):
            f = fields[p["fid"]]
            loc = page.locator(f["selector"])
            if loc.count() == 0:
                rep["missing_on_page"].append(p["fid"])
                continue
            try:
                self._one(page, loc, f, p["action"], p.get("value"), jdir)
                rep["filled"].append(p["fid"])
            except Exception as e:  # noqa: BLE001 - report the field and the error type, never the value
                rep["errors"].append({"fid": p["fid"], "error": type(e).__name__})
            if p["action"] == "upload" and (i + 1 == len(rows) or rows[i + 1]["action"] != "upload"):
                page.wait_for_timeout(2000)  # let resume parsing finish before typing over it
        return read_back(page, rows, fields, rep)

    def _one(self, page, loc, f, act, value, jdir):
        el = loc.first
        if act == "upload":
            el.set_input_files(str(safety.upload_path(jdir, value)))
            if not el.evaluate("e => e.files && e.files.length"):
                raise Unexpected("file not attached")
            return
        if act == "fill":
            el.fill(str(value))
            return
        tag, typ, role = el.evaluate("e => [e.tagName, (e.type || '').toLowerCase(), e.getAttribute('role')]")
        if act == "check":
            if typ != "checkbox":
                raise Unexpected("not a checkbox")
            self._tick(el, bool(value))
            return
        if act != "select":
            raise Unexpected(f"unknown action {act!r}")
        vals = [match_option(f["options"], v) or str(v) for v in (value if isinstance(value, list) else [value])]  # the page's own spelling
        if tag == "SELECT":
            el.select_option(label=vals if f["type"] == "multiselect" else vals[0])
        elif typ in ("radio", "checkbox"):
            for v in vals:
                if v not in f["options"]:
                    raise Unexpected("option not offered")
                self._tick(loc.nth(f["options"].index(v)), True)
        elif role == "combobox":
            el.fill(vals[0])
            page.get_by_role("option", name=vals[0], exact=bool(f["options"])).first.click(timeout=5000)
        elif tag == "INPUT":
            raise Unexpected("a text box cannot take a choice")
        else:  # a question answered by clicking one of its plain buttons
            for v in vals:
                b = el.get_by_role("button", name=v, exact=True).first
                if v not in f["options"] or b.get_attribute("type") != "button" or re.search(r"submit|apply", v, re.I):
                    raise Unexpected("not a plain choice button")
                b.click()

    @staticmethod
    def _tick(loc, on: bool):
        """Check a box or radio; custom-styled ones hide the input, so click its label instead (a label is never a submit)."""
        if loc.is_visible():
            loc.set_checked(on, timeout=5000)
        elif loc.is_checked() != on:
            loc.evaluate("e => { const l = e.closest('label') || (e.id && document.querySelector(`label[for=\"${CSS.escape(e.id)}\"]`)); if (l) l.click() }")
        if loc.is_checked() != on:
            raise Unexpected("box did not change")

    # ---- submit side: only reachable through `jobagent submit` (safety.click_submit checks) ----

    def confirmed(self, page) -> bool:
        return page.get_by_text(SENT).count() > 0

    def submit(self, page, d, job_id):
        safety.click_submit(page, d, job_id, self.SUBMIT)
        end = time.time() + 45
        while time.time() < end:
            if self.confirmed(page):
                return True
            page.wait_for_timeout(1000)
        return self.confirmed(page)
