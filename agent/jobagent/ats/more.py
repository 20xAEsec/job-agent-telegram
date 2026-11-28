"""Breezy, Recruitee and Rippling: no account needed, the rendered form is the schema (DomAdapter). Each one's markup was read
from a live posting (read-only) in 4.1; the submit/confirmation path is NOT verified live. The posting text is the rendered page."""
from .base import place
from .formscan import DomAdapter


class Breezy(DomAdapter):
    """<co>.breezy.hr/p/<id>/apply: an older Angular form with no per-question box; each question is the heading above its box."""
    name = "breezy"
    ROOTS = ['form[name="form"]', "form"]
    SUBMIT = 'button[type="submit"]'
    HOSTS = ["breezy.hr"]

    @staticmethod
    def apply_url(meta):
        return f"https://{meta['board']}.breezy.hr/p/{meta['posting_id']}/apply"

    def posting_text(self, meta):
        return None


class Recruitee(DomAdapter):
    """<co>.recruitee.com/o/<slug>/c/new. Shows an hCaptcha box under the form: reading it works, filling stops at the human
    check, and the user finishes in the window JobAgent fills (handoff)."""
    name = "recruitee"
    ROOTS = ["#offer-application-form", "form"]
    BOX = "fieldset"  # a question's own fieldset; a section's fieldset holds several and names none (formscan)
    LABELS = ["legend"]
    SUBMIT = 'button[type="submit"]'
    HOSTS = ["recruitee.com"]

    @staticmethod
    def apply_url(meta):
        return f"https://{meta['board']}.recruitee.com/o/{meta['posting_id']}/c/new"

    def posting_text(self, meta):
        return None


class Rippling(DomAdapter):
    """ats.rippling.com/<co>/jobs/<id>/apply. Names change on every load, so keys are its unique data-testids; dropdowns are
    drawn boxes (role=combobox) and the location box keeps only a suggested place."""
    name = "rippling"
    ROOTS = ["form"]
    BOX = '[data-testid="field"]'
    LABELS = ['div:has(> [id$="-label"])']  # "Résumé*": the label and the star beside it
    TESTID = "data-testid"
    SUBMIT = 'button[data-testid="Apply"]'
    HOSTS = ["rippling.com"]

    @staticmethod
    def apply_url(meta):
        return f"https://ats.rippling.com/{meta['board']}/jobs/{meta['posting_id']}/apply?step=application"

    def posting_text(self, meta):
        return None

    def _one(self, page, loc, f, act, value, jdir):
        el = loc.first
        if act == "fill" and el.evaluate("e => e.getAttribute('aria-autocomplete') === 'list' && e.getAttribute('role') !== 'combobox'"):
            return place(page, el, str(value), '[role="option"]')
        return super()._one(page, loc, f, act, value, jdir)
