"""Lever (jobs.lever.co/<site>/<id>/apply). The public postings API gives the posting text, not the form, so the form is scanned
from the page. Shapes follow Lever's public postings API and apply page; the submit/confirmation path is NOT verified live."""
import httpx

from .base import Closed
from .formscan import DomAdapter

API = "https://api{eu}.lever.co/v0/postings/{board}"


def pay_line(r: dict | None) -> str:
    if not isinstance(r, dict) or not (r.get("min") or r.get("max")):
        return ""
    return f"Pay: {r.get('currency', '')} {r.get('min', '')} - {r.get('max', '')} ({str(r.get('interval', '')).replace('-', ' ')})".strip()


class Lever(DomAdapter):
    name = "lever"
    ROOTS = ["#application-form", 'form[action*="/apply"]', 'form[enctype="multipart/form-data"]']
    BOX = ".application-question"
    LABELS = [".application-label .text", ".application-label", ".application-question-label", "label"]
    SKIP = r"^(?:g-recaptcha|h-captcha|cf-turnstile|selectedLocation|resumeStorageId|accountId|origin|referer|timezone|socialReferralKey)"
    SUBMIT = '#btn-submit, button[data-qa="btn-submit"], button.template-btn-submit'
    HOSTS = ["lever.co"]

    @staticmethod
    def apply_url(meta):
        return f"https://jobs{'.eu' if meta.get('eu') else ''}.lever.co/{meta['board']}/{meta['posting_id']}/apply"

    @staticmethod
    def api_url(meta, posting=True) -> str:
        u = API.format(eu=".eu" if meta.get("eu") else "", board=meta["board"])
        return f"{u}/{meta['posting_id']}" if posting else f"{u}?mode=json"

    def posting_text(self, meta):
        from ..fetch import html_to_text

        r = httpx.get(self.api_url(meta), timeout=20)
        if r.status_code == 404:
            raise Closed("posting not found")
        r.raise_for_status()
        j = r.json()
        c = j.get("categories") or {}
        where = c.get("location") or ", ".join(c.get("allLocations") or [])
        wp = j.get("workplaceType") or ""
        lists = "\n\n".join(f"{x.get('text', '')}\n{html_to_text(x.get('content') or '')}" for x in j.get("lists") or [])
        head = [f"# {j.get('text', '')}", f"Company: {meta['board']}", f"Location: {where}{f' ({wp})' if wp and wp != 'unspecified' else ''}",
                f"Type: {c.get('commitment', '')}", pay_line(j.get("salaryRange")) or j.get("salaryDescriptionPlain") or ""]
        return "\n".join(x for x in head if x.split(": ")[-1]) + f"\n\n{j.get('descriptionPlain', '')}\n\n{lists}\n\n{j.get('additionalPlain', '')}".rstrip()

    def confirmed(self, page):
        return "/thanks" in page.url or super().confirmed(page)
