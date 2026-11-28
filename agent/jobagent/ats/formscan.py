"""Base for ATSs with no public form-schema API (Lever, Ashby): the rendered form is the schema.
`inspect` scans the page into fields.json rows; `fill` types the plan in and reads it back. Never presses Enter and never clicks
a submit control: the only submit click is `submit` -> safety.click_submit. Form labels are third-party text (data)."""
import re
import time

from .. import browser, safety
from .base import Adapter, Closed, Unexpected, fill_rows, match_option, pick
from .greenhouse import BLOCKER_JS

# Every form control, grouped by name (radio/checkbox groups), with the question text from its container.
# A container with no control but a few plain buttons ("Yes" / "No") is a question answered by clicking one of them.
# Ashby: its location box has no name or id (the container names the question), and its buttons have no type (and no form).
SCAN_JS = r"""([roots, box, labels, skip, testid]) => {
  const form = roots.map(s => document.querySelector(s)).find(Boolean)
  if (!form) return null
  const CTL = 'input:not([type=hidden]), select, textarea, [role="combobox"]'
  const shown = e => { if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const txt = e => e ? (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() : ''
  const ids = v => (v || '').split(/\s+/).map(i => txt(document.getElementById(i))).filter(Boolean).join(' ')
  const lab = e => e.closest('label') || (e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null)
  const role = e => e.closest('[role="radio"], [role="checkbox"]')  // custom-drawn tick boxes: the native input is hidden inside
  const head = q => { for (const s of labels) { const h = q && q.querySelector(s); if (txt(h)) return txt(h) } return '' }
  const sect = e => { const s = e.closest('fieldset, [class*="section"], [class*="Section"]'); return txt(s && s.querySelector('legend, h1, h2, h3, h4, [class*="title"], [class*="heading"]')).slice(0, 120) }
  const plain = b => b.getAttribute('type') === 'button' || (!b.hasAttribute('type') && !b.form)  // inside a form an untyped button submits
  const path = e => box && e.getAttribute('role') === 'combobox' && e.closest(box)?.dataset.fieldPath
  const reqIn = q => !!(q && q.querySelector('.required, [class*="required"], [class*="Required"]'))
  // text just above a control that has no label of its own (a heading over the box), never crossing another question
  const before = e => { for (let x = e; x && x !== form; x = x.parentElement)
      for (let p = x.previousElementSibling; p; p = p.previousElementSibling) {
        if (p.matches(CTL) || p.querySelector(CTL)) return ''
        const t = txt(p); if (t) return t.slice(0, 300) }
    return '' }
  const after = e => { const n = e.nextElementSibling; return n && !n.matches(CTL) && !n.querySelector(CTL) ? txt(n) : '' }  // a tick box's own words beside it
  // sites whose names change on every load (Rippling): the nearest test id that is unique in the form is the stable key
  const tid = e => { if (!testid) return ''
    for (let x = e; x && x !== form; x = x.parentElement) { const v = x.getAttribute(testid)
      if (v && form.querySelectorAll(`[${testid}="${CSS.escape(v)}"]`).length === 1) return v }
    return '' }
  // does this control hold an answer? A searchable dropdown clears its typing box and shows the choice beside it
  const has = e => { const t = (e.type || '').toLowerCase()
    if (t === 'radio' || t === 'checkbox') return e.checked || role(e)?.getAttribute('aria-checked') === 'true'
    if (t === 'file') return !!(e.files && e.files.length)
    if (e.getAttribute('role') === 'combobox' && e.tagName !== 'INPUT') return !!txt(e) && !/^(select|choose|search)\b[^]{0,20}$/i.test(txt(e))
    const c = e.getAttribute('role') === 'combobox' && e.closest('[class*="control"], [class*="Control"]')
    if (c && [...c.querySelectorAll('[class*="single-value"], [class*="multi-value"], [class*="singleValue"], [class*="multiValue"]')].some(txt)) return true
    return !!String(e.value || '').trim() }
  const groups = new Map()
  for (const e of form.querySelectorAll(CTL)) {
    if (e.tagName === 'INPUT' && e.getAttribute('role') !== 'combobox' && e.matches('[role="combobox"] *')) continue  // a dropdown's own typing box
    const t = (e.type || '').toLowerCase(), tick = t === 'radio' || t === 'checkbox'
    const key = (tick ? e.name || tid(e) : tid(e) || e.name) || e.id || path(e)
    if (!key || (e.tagName === 'INPUT' && /^(hidden|submit|button|reset|image)$/.test(t)) || new RegExp(skip).test(key)) continue
    if (e.tagName === 'BUTTON' && !plain(e)) continue  // a dropdown drawn as a button that would submit the form when opened
    if (!(t === 'file' || shown(e) || (tick && (shown(lab(e)) || shown(role(e)))))) continue
    // a trap for bots (a box people never see, in a part of the page hidden from screen readers): filling it marks the application as spam
    if (!tick && t !== 'file' && (e.closest('[aria-hidden="true"]') || /honeypot|^hp[_-]/i.test(e.name || e.id || ''))) continue
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') continue  // greyed out by another answer (an end date once "current role" is ticked)
    if (!groups.has(key)) groups.set(key, { by: tid(e) === key ? 'testid' : e.name === key ? 'name' : e.id === key ? 'id' : 'path', els: [] })
    groups.get(key).els.push(e)
  }
  // a question's box holds that one question: a wrapper around several ("My information") names none of them
  const all = [...groups.values()].map(g => g.els[0])
  const boxOf = e => { const q = box && e.closest(box); return q && all.filter(x => q.contains(x)).length === 1 ? q : null }
  const keyed = new Set([...groups.values()].flatMap(g => g.els))
  const used = new Set(), out = []
  for (const [key, g] of groups) {
    const e = g.els[0], t = (e.type || '').toLowerCase(), tag = e.tagName, q = boxOf(e)
    if (q) used.add(q)
    const many = t === 'radio' || (t === 'checkbox' && g.els.length > 1)
    const own = many ? txt(e.closest('fieldset')?.querySelector('legend')) || before(e)  // one option's words are not the question
      : txt(lab(e)) || ids(e.getAttribute('aria-labelledby')) || (t === 'checkbox' ? ids(role(e)?.getAttribute('aria-labelledby')) || after(e) : '')
    const label = head(q) || own || e.getAttribute('aria-label') || before(e) || e.placeholder || key
    const type = tag === 'TEXTAREA' ? 'textarea' : tag === 'SELECT' ? (e.multiple ? 'multiselect' : 'select') : t === 'file' ? 'file'
      : t === 'radio' ? 'select' : t === 'checkbox' ? (many ? 'multiselect' : 'checkbox') : e.getAttribute('role') === 'combobox' ? 'select'
      : t === 'date' || t === 'month' ? t : 'text'
    const opt = x => txt(lab(x)) || ids(role(x)?.getAttribute('aria-labelledby')) || txt(role(x)) || after(x) || x.value
    const options = tag === 'SELECT' ? [...e.options].filter(o => o.value !== '' && !o.disabled).map(txt) : many ? g.els.map(opt) : []
    const max = (tag === 'TEXTAREA' || type === 'text') && e.maxLength > 0 && e.maxLength < 100000 ? e.maxLength : null
    out.push({ key, by: g.by, label, type, options, section: sect(e), filled: g.els.some(has), max,
               required: g.els.some(x => x.required || x.getAttribute('aria-required') === 'true') || /[*✱]\s*$/.test(label) || reqIn(q) })
  }
  if (box) form.querySelectorAll(box).forEach((q, i) => {
    if (used.has(q) || [...q.querySelectorAll(CTL)].some(x => keyed.has(x)) || q.querySelector('input[type=file]')) return  // an upload's own buttons (Attach, Dropbox) are not a question
    const b = [...q.querySelectorAll('button')].filter(x => plain(x) && shown(x))
    if (b.length < 2 || b.length > 8 || b.some(x => !txt(x) || txt(x).length > 40)) return
    const pressed = b.filter(x => x.hasAttribute('aria-pressed'))
    out.push({ key: `choice-${i}`, by: 'box', index: i, label: head(q) || `choice ${i}`, type: 'select', options: b.map(txt), section: sect(q),
               filled: pressed.length ? pressed.some(x => x.getAttribute('aria-pressed') === 'true') : null,
               required: /[*✱]\s*$/.test(head(q)) || reqIn(q) })
  })
  return out
}"""
CONTROL = 'input:not([type=hidden]), select, textarea, [role="combobox"]'
EEO = re.compile(r"equal employment|\beeoc?\b|self[- ]identif|demographic|diversity|\bgender\b|\brace\b|ethnicity|hispanic|latino|veteran|disabilit", re.I)
CLOSED = re.compile(r"no longer (?:available|accepting|open)|job not found|page not found|couldn.t find|posting (?:is )?closed|\b404\b", re.I)
SENT = re.compile(r"thank(?:s| you) for (?:applying|your (?:application|interest))|application (?:was |has been )?(?:submitted|received)", re.I)


def _q(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"')


def scan_form(page, roots: list[str], box: str, labels: list[str], skip: str, testid: str = "") -> list[dict] | None:
    """Every visible control on the rendered form as a fields.json row, plus `filled`: does it hold an answer right now
    (None: cannot tell). The page is the truth; an API only ever describes part of it. `testid`: the attribute whose unique
    values are the keys, for sites whose names change on every load."""
    rows = page.evaluate(SCAN_JS, [roots, box, labels or ["label"], skip, testid])
    if rows is None:
        return None
    out = []
    for r in rows:
        k = _q(r["key"])
        sel = (f'{box} >> nth={r["index"]}' if r["by"] == "box" else f'[data-field-path="{k}"] input[role="combobox"]' if r["by"] == "path"
               else f'[{testid}="{k}"]:is(input, select, textarea, [role="combobox"]), [{testid}="{k}"] :is({CONTROL})' if r["by"] == "testid"
               else f'[{r["by"]}="{k}"]')
        label = re.sub(r"\s*[*✱]\s*$", "", r["label"]).strip()[:300]
        sec = "demographic" if r["key"].startswith("eeo") or EEO.search(f'{r["section"]} {label}') else "compliance" if r["key"].startswith("consent") else "main"
        out.append({"fid": r["key"], "label": label, "type": r["type"], "required": bool(r["required"]), "options": [o[:200] for o in r["options"]],
                    "selector": sel, "section": sec, **({"max_chars": r["max"]} if r.get("max") else {}), "filled": r["filled"], "group": r["section"]})
    return out


def as_fields(rows: list[dict]) -> list[dict]:
    """Scan rows as fields.json rows (without the scan-time extras). `prefilled`: the page itself put an answer there (a country
    code, "+31"); a required one needs no answer from the user."""
    return [{**{k: v for k, v in r.items() if k not in ("filled", "group")}, **({"prefilled": True} if r.get("filled") else {})} for r in rows]


# The open popup's choices: an explicit role="option" that is on screen (a native <select>'s hidden <option>s are not it).
OPTIONS_JS = """() => [...document.querySelectorAll('[role="option"]')].filter(e => e.getBoundingClientRect().height > 0)
  .map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200)).filter(Boolean)"""


def harvest(page, fields: list[dict]) -> None:
    """Open each searchable dropdown with no known options and keep its choices when they are a fixed list, so the plan uses
    the page's own words ("Master", not "M.S."). A fixed list only narrows as you type; a search box (schools, places) brings
    new results, and keeps no options so the plan matches loosely. Types one letter, then clears it and presses Escape:
    nothing is chosen and Enter is never pressed."""
    for f in fields:
        if f["type"] != "select" or f["options"] or ">>" in f["selector"]:
            continue
        loc = page.locator(f["selector"]).first
        try:
            if loc.get_attribute("role", timeout=2000) != "combobox":
                continue
            loc.click(timeout=3000)
            page.wait_for_timeout(400)
            got, new = page.evaluate(OPTIONS_JS), []
            if loc.evaluate("e => e.tagName === 'INPUT'"):  # a dropdown drawn as a button or box takes no typing: its list is fixed
                loc.fill("e")
                page.wait_for_timeout(1200)  # a search box asks its server
                new = [o for o in page.evaluate(OPTIONS_JS) if o not in got]
                loc.fill("")
            page.keyboard.press("Escape")
        except Exception:  # noqa: BLE001 - a dropdown that will not open keeps no options: the plan matches loosely
            continue
        # shortcut: 100+ choices (the country list, about 245) stay loose too: "United States" still finds "United States +1"
        if got and not new and len(got) < 100:
            f["options"] = got


def empty_required(rows: list[dict], fields: dict) -> list[dict]:
    """The visible required boxes with no answer ({fid, label, selector}). The plan's label wins: some pages label an upload "Attach"."""
    return [{"fid": r["fid"], "label": (fields.get(r["fid"]) or r)["label"], "selector": r["selector"]} for r in rows if r["required"] and r["filled"] is False]


class DomAdapter(Adapter):
    ROOTS: list[str] = ["form"]  # the application form, first match wins
    BOX = ""                     # one question's container
    LABELS: list[str] = []       # the question text inside BOX, tried in order
    SKIP = r"^(?:g-recaptcha|h-captcha|cf-turnstile)"  # control names that are not questions
    SUBMIT = 'button[type="submit"]'
    HOSTS: list[str] = []
    WAIT = 20000                 # ms for a single-page app to render its form
    TESTID = ""                  # attribute with stable keys, for sites whose names change on every load

    @classmethod
    def allowed_hosts(cls, meta):
        return list(cls.HOSTS)

    # ---- reading the form ----

    def scan(self, page) -> list[dict] | None:
        return scan_form(page, self.ROOTS, self.BOX, self.LABELS, self.SKIP, self.TESTID)

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
            if b and not (b == "captcha" and self._root(page)):  # a human-check box under the form: read it, the user finishes it
                raise Unexpected(b)
            fields = self.scan(page)
            if fields:
                harvest(page, fields)
        if not fields:
            raise Unexpected("form not found on the page")
        return as_fields(fields)

    def extra_on_page(self, page, fields):
        now = self.scan(page) or []
        x = [f for f in now if f["fid"] not in fields]  # e.g. a follow-up question that appeared after an answer
        return sorted(f["fid"] for f in x), sorted(f["fid"] for f in x if f["required"])

    def empty_required(self, page, fields):
        return empty_required(self.scan(page) or [], fields)

    # ---- typing the plan in ----

    def fill(self, page, plan_fields, fields, jdir):
        return fill_rows(page, plan_fields, fields, self._one, jdir)

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
            for v in vals if f["type"] == "multiselect" else vals[:1]:
                pick(page, el, v, exact=bool(f["options"]))
        elif tag == "INPUT":
            raise Unexpected("a text box cannot take a choice")
        else:  # a question answered by clicking one of its plain buttons
            for v in vals:
                b = el.get_by_role("button", name=v, exact=True).first
                plain = "e => e.getAttribute('type') === 'button' || (!e.hasAttribute('type') && !e.form)"
                if v not in f["options"] or re.search(r"submit|apply", v, re.I) or not b.evaluate(plain):
                    raise Unexpected("not a plain choice button")
                b.click()

    @staticmethod
    def _tick(loc, on: bool):
        """Check a box or radio; custom-styled ones hide the input, so click its label, or the drawn box that stands for it
        (role="radio"/"checkbox"), instead. Neither is ever a submit."""
        state = "e => e.checked || e.closest('[role=radio], [role=checkbox]')?.getAttribute('aria-checked') === 'true'"
        if loc.is_visible():
            loc.set_checked(on, timeout=5000)
        elif loc.evaluate(state) != on:
            loc.evaluate("e => { const l = e.closest('label') || (e.id && document.querySelector(`label[for=\"${CSS.escape(e.id)}\"]`))"
                         " || e.closest('[role=radio], [role=checkbox]'); if (l) l.click() }")
        if loc.evaluate(state) != on:
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
