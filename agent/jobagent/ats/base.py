"""Adapter interface (DESIGN 12). A Field is a dict: {fid, label, type, required, options[], selector, section}."""
import re


class Unexpected(Exception):
    """The page is not what the adapter expects (unknown control, failed navigation): a human must look."""


class Closed(Exception):
    """The posting is gone (404 or redirected to an error page)."""


def match_option(options: list[str], value) -> str | None:
    """The field's own option text for `value`, ignoring case and spacing ("yes" -> "Yes"); None when it is not offered."""
    want = " ".join(str(value).split()).casefold()
    return next((o for o in options if " ".join(o.split()).casefold() == want), None)


def read_back(page, rows: list[dict], fields: dict, rep: dict) -> dict:
    """Every typed value must still be in its box after the whole form is filled (pages reformat, truncate or reset them)."""
    norm = lambda v: " ".join(str(v).split())  # noqa: E731
    digits = lambda v: re.sub(r"\D", "", str(v))  # noqa: E731
    for p in rows:
        if p.get("action") == "fill" and p["fid"] in rep["filled"]:
            got = page.locator(fields[p["fid"]]["selector"]).first.input_value()
            want = norm(p.get("value"))
            # still counts as kept: a phone box reformats; a place box completes what was typed ("Austin" -> "Austin, TX, USA")
            if norm(got) != want and not (digits(want) and digits(got) == digits(want)) and not (want and norm(got).casefold().startswith(want.casefold())):
                rep["filled"].remove(p["fid"])
                rep["errors"].append({"fid": p["fid"], "error": "value_not_kept"})
    return rep


def fill_rows(page, plan_fields: list[dict], fields: dict, one, jdir) -> dict:
    """Type the plan in with `one(page, locator, field, action, value, jdir)`. Uploads first (resume parsing re-fills the name boxes
    on some forms); a box not on the page yet gets a second try at the end (follow-up questions appear after an earlier answer);
    then every typed value is read back. Never presses Enter, never clicks a submit control."""
    rep = {"filled": [], "errors": [], "missing_on_page": []}
    try:  # a form can show before its scripts are ready: an upload that early is lost (Greenhouse: "reading 'uploadFile'")
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:  # noqa: BLE001 - pages that never go quiet (chat widgets) are filled anyway; uploads are checked one by one
        pass
    rows = sorted((p for p in plan_fields if p.get("action") != "skip" and p["fid"] in fields), key=lambda p: p.get("action") != "upload")

    def go(p):
        try:
            one(page, page.locator(fields[p["fid"]]["selector"]), fields[p["fid"]], p["action"], p.get("value"), jdir)
            rep["filled"].append(p["fid"])
        except Exception as e:  # noqa: BLE001 - report the field and the error type, never the value
            rep["errors"].append({"fid": p["fid"], "error": type(e).__name__})

    later = []
    for i, p in enumerate(rows):
        if page.locator(fields[p["fid"]]["selector"]).count() == 0:
            later.append(p)
            continue
        go(p)
        if p["action"] == "upload" and (i + 1 == len(rows) or rows[i + 1]["action"] != "upload"):
            page.wait_for_timeout(2000)  # let resume parsing finish before typing over it
    for p in later:
        if page.locator(fields[p["fid"]]["selector"]).count() == 0:
            rep["missing_on_page"].append(p["fid"])
        else:
            go(p)
    return read_back(page, rows, fields, rep)


US_STATE = dict(s.split(" ", 1) for s in (
    "AL Alabama,AK Alaska,AZ Arizona,AR Arkansas,CA California,CO Colorado,CT Connecticut,DE Delaware,DC District of Columbia,FL Florida,"
    "GA Georgia,HI Hawaii,ID Idaho,IL Illinois,IN Indiana,IA Iowa,KS Kansas,KY Kentucky,LA Louisiana,ME Maine,MD Maryland,MA Massachusetts,"
    "MI Michigan,MN Minnesota,MS Mississippi,MO Missouri,MT Montana,NE Nebraska,NV Nevada,NH New Hampshire,NJ New Jersey,NM New Mexico,"
    "NY New York,NC North Carolina,ND North Dakota,OH Ohio,OK Oklahoma,OR Oregon,PA Pennsylvania,RI Rhode Island,SC South Carolina,"
    "SD South Dakota,TN Tennessee,TX Texas,UT Utah,VT Vermont,VA Virginia,WA Washington,WV West Virginia,WI Wisconsin,WY Wyoming").split(","))


def _option_name(label: str, exact: bool):
    """A loose "Austin, TX" is listed by place boxes as "Austin, Texas, United States": that city in that state, nothing else."""
    m = None if exact else re.fullmatch(r"\s*([^,]+), ([A-Z]{2})\s*", label)
    if m and m[2] in US_STATE:
        return re.compile(rf"^\s*{re.escape(m[1])}, (?:{m[2]}|{US_STATE[m[2]]})\b", re.I)
    return label


def pick(page, loc, label: str, exact: bool = True) -> None:
    """A searchable dropdown (react-select and kin): focus, type to filter, click the option, then check it took.
    No Enter key anywhere. Some boxes show less than the option said (the country box shows only "+1")."""
    if loc.get_attribute("role") != "combobox":
        raise Unexpected("not a combobox")
    typing, submits = loc.evaluate("e => [e.tagName === 'INPUT' || e.isContentEditable, e.tagName === 'BUTTON' && e.type !== 'button' && !!e.form]")
    if submits:  # a button with no type inside a form sends it
        raise Unexpected("dropdown button would submit the form")
    loc.click()  # a button or box opens a fixed list: click, no typing
    if typing:
        loc.fill(label)
    opt = page.get_by_role("option", name=_option_name(label, exact), exact=exact).first
    picked = opt.inner_text(timeout=5000).strip()
    opt.click(timeout=5000)
    box = loc.locator("xpath=ancestor::*[contains(translate(@class, 'CONTROL', 'control'), 'control')][1]")
    shown = loc.inner_text().strip() if not typing else box.inner_text().strip() if box.count() else picked  # no control wrapper: nothing more to check
    if not shown or (label.casefold() not in shown.casefold() and shown not in picked):
        raise Unexpected("option not selected")


def place(page, el, value: str, options: str) -> None:
    """A place box that keeps only a place picked from its suggestions (a pasted value is wiped): type it key by key, then
    click the suggestion (`options`, a selector) that starts with it, or the first one. No Enter key."""
    el.fill("")
    el.press_sequentially(value, delay=40)
    opts = page.locator(options)
    try:
        opts.first.wait_for(timeout=8000)
    except Exception:  # noqa: BLE001
        raise Unexpected("no place suggested for this location") from None
    texts = opts.all_inner_texts()
    i = next((n for n, t in enumerate(texts) if t.strip().casefold().startswith(value.casefold())), 0)
    opts.nth(i).click()


DATE_IN = ("%Y-%m-%d", "%Y-%m", "%m/%d/%Y", "%m/%Y", "%B %d, %Y", "%b %d, %Y", "%d %B %Y", "%B %Y", "%b %Y", "%Y")


def iso_date(value, kind: str = "date") -> str | None:
    """A date box takes only YYYY-MM-DD, a month box YYYY-MM: "03/15/2026", "March 2026", "2026-03" all become that. None: not a date."""
    from datetime import datetime

    for f in DATE_IN:
        try:
            d = datetime.strptime(" ".join(str(value).split()), f)
        except ValueError:
            continue
        return d.strftime("%Y-%m" if kind == "month" else "%Y-%m-%d")
    return None


class Adapter:
    name = ""

    @staticmethod
    def allowed_hosts(meta: dict) -> list[str]: raise NotImplementedError
    @staticmethod
    def apply_url(meta: dict) -> str: raise NotImplementedError
    def posting_text(self, meta: dict) -> str | None: raise NotImplementedError   # the posting as text (None: render the page)
    def inspect(self, meta: dict, d=None, prepare=None) -> list[dict]: raise NotImplementedError  # -> fields.json
    def fill(self, page, plan_fields: list[dict], fields: dict, jdir) -> dict: raise NotImplementedError  # never submits
    def extra_on_page(self, page, fields: dict) -> tuple[list[str], list[str]]: raise NotImplementedError  # (unlisted ids, required ones)
    def empty_required(self, page, fields: dict) -> list[dict]: raise NotImplementedError  # visible required boxes left empty: {fid, label, selector}
    def detect_blockers(self, page) -> str | None: raise NotImplementedError        # captcha | login | closed | None
    def submit(self, page, d, job_id: str) -> bool: raise NotImplementedError       # calls safety.click_submit
