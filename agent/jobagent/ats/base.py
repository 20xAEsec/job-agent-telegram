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
            if norm(got) != norm(p.get("value")) and not (digits(p.get("value")) and digits(got) == digits(p.get("value"))):  # phone boxes reformat
                rep["filled"].remove(p["fid"])
                rep["errors"].append({"fid": p["fid"], "error": "value_not_kept"})
    return rep


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
    def detect_blockers(self, page) -> str | None: raise NotImplementedError        # captcha | login | closed | None
    def submit(self, page, d, job_id: str) -> bool: raise NotImplementedError       # calls safety.click_submit
