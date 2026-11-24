"""Ashby (jobs.ashbyhq.com/<board>/<id>/application). The public job-board API lists postings with their text and pay; the form
is a single-page app, scanned once rendered. Shapes follow Ashby's public posting API and form markup; the submit path is NOT verified live."""
import httpx

from .base import Closed
from .formscan import DomAdapter

API = "https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true"


def board_jobs(board: str) -> list[dict] | None:
    """The board's listed jobs, or None when there is no such board."""
    from ..fetch import _get

    r = _get(API.format(board=board))
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return [j for j in r.json().get("jobs") or [] if j.get("isListed", True)]


def pay_max(job: dict, currency: str) -> int | None:
    comps = ((job.get("compensation") or {}).get("summaryComponents")) or []
    tops = [c.get("maxValue") for c in comps if c.get("compensationType") == "Salary" and c.get("currencyCode") == currency
            and "YEAR" in str(c.get("interval", "")).upper() and isinstance(c.get("maxValue"), (int, float))]
    return int(max(tops)) if tops else None


def where(job: dict) -> str:
    loc = str(job.get("location") or "")
    remote = job.get("isRemote") or str(job.get("workplaceType", "")).lower() == "remote"
    return f"{loc} (Remote)".strip() if remote and "remote" not in loc.lower() else loc


class Ashby(DomAdapter):
    name = "ashby"
    ROOTS = [".ashby-application-form-container", "form"]
    BOX = ".ashby-application-form-field-entry"
    LABELS = [".ashby-application-form-question-title", "label", "legend"]
    SUBMIT = "button.ashby-application-form-submit-button"
    HOSTS = ["ashbyhq.com"]

    @staticmethod
    def apply_url(meta):
        return f"https://jobs.ashbyhq.com/{meta['board']}/{meta['posting_id']}/application"

    def posting_text(self, meta):
        jobs = board_jobs(meta["board"])
        if jobs is None:
            raise Closed("board not found")
        j = next((x for x in jobs if str(x.get("id", "")).lower() == meta["posting_id"]), None)
        if j is None:
            return None  # unlisted (or just closed): the rendered page says which
        pay = (j.get("compensation") or {}).get("compensationTierSummary") or ""
        head = [f"# {j.get('title', '')}", f"Company: {meta['board']}", f"Location: {where(j)}", f"Type: {j.get('employmentType', '')}", f"Pay: {pay}"]
        return "\n".join(x for x in head if x.split(": ")[-1]) + f"\n\n{j.get('descriptionPlain', '')}"
